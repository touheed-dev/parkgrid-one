import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { addVehicle, app, auth, resetDb, signup } from "./helpers.js";

beforeEach(resetDb);
afterAll(async () => {
  await pool.end();
});

describe("vehicles", () => {
  it("normalises plates, rejects duplicates, enforces EV connector rule", async () => {
    const u = await signup();
    const v = await addVehicle(u, { plate_number: "mh12-ab1234" });
    expect(v["plate_number"]).toBe("MH12AB1234");

    const dup = await request(app).post("/vehicles").set(auth(u)).send({ plate_number: "MH12AB1234", vehicle_type: "car" });
    expect(dup.status).toBe(409);

    const noConnector = await request(app).post("/vehicles").set(auth(u)).send({ plate_number: "MH12EV0001", vehicle_type: "ev" });
    expect(noConnector.status).toBe(400);
    const ev = await request(app).post("/vehicles").set(auth(u)).send({ plate_number: "MH12EV0001", vehicle_type: "ev", connector_type: "CCS2" });
    expect(ev.status).toBe(201);
    expect(ev.body.vehicle.is_ev).toBe(true);
  });

  it("allows at most 5 active vehicles", async () => {
    const u = await signup();
    for (let i = 0; i < 5; i++) await addVehicle(u, { plate_number: `KA01AB000${i}` });
    const sixth = await request(app).post("/vehicles").set(auth(u)).send({ plate_number: "KA01AB9999", vehicle_type: "car" });
    expect(sixth.status).toBe(400);
    expect(sixth.body.error.code).toBe("VEHICLE_LIMIT");
  });

  it("keeps exactly one default and archives instead of deleting", async () => {
    const u = await signup();
    const a = await addVehicle(u, { plate_number: "KA01AA0001", is_default: true });
    const b = await addVehicle(u, { plate_number: "KA01AA0002" });
    await request(app).post(`/vehicles/${b.id}/default`).set(auth(u)).expect(200);
    const list = await request(app).get("/vehicles").set(auth(u));
    const defaults = list.body.vehicles.filter((v: { is_default: boolean }) => v.is_default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(b.id);

    await request(app).delete(`/vehicles/${a.id}`).set(auth(u)).expect(200);
    expect((await request(app).get("/vehicles").set(auth(u))).body.vehicles).toHaveLength(1);
    expect((await request(app).get("/vehicles?includeArchived=true").set(auth(u))).body.vehicles).toHaveLength(2);
  });

  it("IDOR: user B cannot see, edit, default or archive user A's vehicle (404, not 403)", async () => {
    const a = await signup();
    const b = await signup();
    const v = await addVehicle(a);
    expect((await request(app).get("/vehicles").set(auth(b))).body.vehicles).toHaveLength(0);
    const edit = await request(app).patch(`/vehicles/${v.id}`).set(auth(b)).send({ plate_number: "HACK123456", vehicle_type: "car" });
    expect(edit.status).toBe(404);
    expect((await request(app).post(`/vehicles/${v.id}/default`).set(auth(b))).status).toBe(404);
    expect((await request(app).delete(`/vehicles/${v.id}`).set(auth(b))).status).toBe(404);
    // still intact for the owner
    expect((await request(app).get("/vehicles").set(auth(a))).body.vehicles).toHaveLength(1);
  });

  it("rejects mass-assignment of user_id / archived_at", async () => {
    const a = await signup();
    const b = await signup();
    const res = await request(app).post("/vehicles").set(auth(a)).send({ plate_number: "MH12AB0001", vehicle_type: "car", user_id: b.id });
    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    expect((await request(app).get("/vehicles")).status).toBe(401);
  });
});
