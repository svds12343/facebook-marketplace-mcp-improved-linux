export function result<T extends Record<string, unknown>>(data: T, text = JSON.stringify(data, null, 2)) {
  return { content: [{ type: "text" as const, text }], structuredContent: data };
}
export function guarded<T extends unknown[]>(handler: (...args: T) => Promise<ReturnType<typeof result>>) {
  return async (...args: T) => {
    try { return await handler(...args); }
    catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Operation failed" }], isError: true }; }
  };
}
