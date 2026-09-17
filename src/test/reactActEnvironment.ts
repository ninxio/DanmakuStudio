type ReactActGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

function enableReactActEnvironment(target: unknown): void {
  if (typeof target === "object" && target !== null) {
    (target as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
  }
}

enableReactActEnvironment(globalThis);
enableReactActEnvironment(globalThis.window);
enableReactActEnvironment(globalThis.self);
