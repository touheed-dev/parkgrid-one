import { TEST_DB_URL } from "./test-env.js";

// Runs in every test worker BEFORE any app module is imported.
process.env["NODE_ENV"] = "test";
process.env["DATABASE_URL"] = TEST_DB_URL;
process.env["JWT_ACCESS_SECRET"] = "test-secret-test-secret-test-secret-1234567890";
process.env["PAYMENT_PROVIDER"] = process.env["PAYMENT_PROVIDER"] ?? "mock";
process.env["RAZORPAY_KEY_ID"] = "rzp_test_unit";
process.env["RAZORPAY_KEY_SECRET"] = "unit_test_key_secret";
process.env["RAZORPAY_WEBHOOK_SECRET"] = "unit_test_webhook_secret";
process.env["CRON_SECRET"] = "test-cron-secret-0000";
process.env["ENABLE_JOBS"] = "false";
process.env["OPENAI_API_KEY"] = "";
process.env["GROQ_API_KEY"] = "";
