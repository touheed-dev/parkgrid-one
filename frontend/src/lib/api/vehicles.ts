import type { ConnectorType, VehicleRow, VehicleType } from "@/types/api";
import { http } from "./http";

export type { ConnectorType, VehicleRow, VehicleType };

export interface CreateVehicleInput {
  plate_number: string;
  vehicle_type: VehicleType;
  make?: string | null | undefined;
  model?: string | null | undefined;
  color?: string | null | undefined;
  is_ev?: boolean;
  connector_type?: ConnectorType | null | undefined;
  is_default?: boolean;
}
export type UpdateVehicleInput = CreateVehicleInput & { id: string };

const body = (d: CreateVehicleInput) => ({
  plate_number: d.plate_number,
  vehicle_type: d.vehicle_type,
  make: d.make ?? null,
  model: d.model ?? null,
  color: d.color ?? null,
  is_ev: d.is_ev ?? false,
  connector_type: d.connector_type ?? null,
  is_default: d.is_default ?? false,
});

export const listVehicles = ({ data }: { data?: { includeArchived?: boolean } } = {}) =>
  http.get<{ vehicles: VehicleRow[] }>("/vehicles", {
    includeArchived: data?.includeArchived ? "true" : "false",
  });

export const createVehicle = ({ data }: { data: CreateVehicleInput }) =>
  http.post<{ vehicle: VehicleRow }>("/vehicles", body(data));

export const updateVehicle = ({ data }: { data: UpdateVehicleInput }) =>
  http.patch<{ vehicle: VehicleRow }>(`/vehicles/${data.id}`, body(data));

export const setDefaultVehicle = ({ data }: { data: { id: string } }) =>
  http.post<{ vehicle: VehicleRow }>(`/vehicles/${data.id}/default`);

export const archiveVehicle = ({ data }: { data: { id: string } }) =>
  http.delete<{ success: boolean; id: string }>(`/vehicles/${data.id}`);
