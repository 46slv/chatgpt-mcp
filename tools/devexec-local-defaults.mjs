/**
 * SHIRO-WS local lane defaults.
 *
 * This is intentionally a data-only module shared by the relay, the
 * TaskContract worker, and the startup/preflight documentation.  Keeping the
 * values in one place prevents a stale model or port from becoming an
 * accidental implicit fallback in one of the older entrypoints.
 */
export const SPARK_PRIMARY_RUNTIME = "local";
export const SPARK_PRIMARY_PROVIDER = "llamacpp";
export const SPARK_PRIMARY_MODEL = "Spark-X2.5-4B-Q6_K.gguf";
export const SPARK_PRIMARY_MODEL_ID = "Spark-X2.5-4B-Q6_K.gguf";
export const SPARK_PRIMARY_SERVE_URL = "http://127.0.0.1:18080";
export const SPARK_PRIMARY_RELAY_URL = `${SPARK_PRIMARY_SERVE_URL}/v1`;
export const SPARK_PRIMARY_CONTEXT_LENGTH = 32768;
export const SPARK_LONG_CONTEXT_LENGTH = 65536;
export const SPARK_PRIMARY_DEVICE_NAME = "NVIDIA GeForce RTX 3070 Ti";

// Qwen remains a deliberately explicit compatibility lane.  No caller may
// reach it through an omitted model/provider value.
export const QWEN_COMPATIBILITY_MODEL = "qwen/qwen3.5-4b";

export const SPARK_PRIMARY_ENV = Object.freeze({
  DEV_EXEC_RUNTIME: SPARK_PRIMARY_RUNTIME,
  DEV_EXEC_PROVIDER: SPARK_PRIMARY_PROVIDER,
  DEV_EXEC_LOCAL_ENABLED: "1",
  LLAMACPP_ENABLED: "1",
  LLAMACPP_MODEL: SPARK_PRIMARY_MODEL,
  LLAMACPP_SERVE_URL: SPARK_PRIMARY_SERVE_URL,
  LLAMACPP_CONTEXT: String(SPARK_PRIMARY_CONTEXT_LENGTH),
  LLAMACPP_DEVICE_NAME: SPARK_PRIMARY_DEVICE_NAME,
});
