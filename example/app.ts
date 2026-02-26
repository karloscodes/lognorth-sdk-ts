import express from "express";
import LogNorth from "@karloscodes/lognorth-sdk";
import { middleware } from "@karloscodes/lognorth-sdk/express";

LogNorth.config("http://localhost:8080", process.env.LOGNORTH_API_KEY!);

const app = express();

app.use(middleware());

app.get("/", (_req, res) => {
  res.send("Hello from Express example");
});

app.get("/users", (_req, res) => {
  LogNorth.log("listing users", { page: 1, limit: 20 });
  res.json([{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }]);
});

app.post("/orders", (_req, res) => {
  LogNorth.log("order created", { order_id: 42, total: 99.95 });
  LogNorth.log("sending confirmation email", { order_id: 42 });
  res.status(201).json({ id: 42 });
});

app.get("/error", (_req, res) => {
  const err = new Error("something broke");
  LogNorth.error("triggered test error", err);
  res.status(500).send("error triggered, check LogNorth");
});

app.get("/timeout", async (_req, res) => {
  LogNorth.log("starting slow operation");
  await new Promise((r) => setTimeout(r, 2000));
  const err = new Error("connection timeout after 30s");
  LogNorth.error("database query failed", err, { query: "SELECT * FROM users" });
  res.status(500).send("timeout error triggered");
});

app.listen(8081, () => {
  console.log("Express example running on :8081");
});
