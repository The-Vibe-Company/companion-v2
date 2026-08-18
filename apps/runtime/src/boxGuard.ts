/**
 * Temporary guard around the broad layout-staging adapter. Runtime v2 creates Boxes only through
 * its durable lifecycle port; every later staging call must preserve that checkpointed identity.
 */
export function preventImplicitBoxCreate<T extends object>(runtime: T): T {
  return new Proxy(runtime, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "start" && typeof value === "function") {
        return (rawInput: unknown): unknown => {
          if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
            throw new TypeError("Box runtime start input must be an object");
          }
          return Reflect.apply(value, target, [{
            ...(rawInput as Record<string, unknown>),
            allowBoxCreate: false,
          }]);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
