import express from "express";
import LogNorth from "@karloscodes/lognorth-sdk";
import { middleware } from "@karloscodes/lognorth-sdk/express";

LogNorth.config("http://localhost:8080", process.env.LOGNORTH_API_KEY!);

const app = express();

app.use(middleware());

app.get("/", (req, res) => {
  LogNorth.log("homepage visited", { ua: req.get("user-agent") });
  res.send("Hello from Express example");
});

app.get("/error", (req, res) => {
  const err = new Error("something broke");
  LogNorth.error("triggered test error", err);
  res.status(500).send("error triggered, check LogNorth");
});

app.listen(8081, () => {
  console.log("Express example running on :8081");
});
