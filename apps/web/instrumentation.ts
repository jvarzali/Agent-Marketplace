export async function register() {
  // This file is also compiled for the edge runtime; Node-only code lives in its own module.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
