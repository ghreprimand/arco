// Only live workflow objects retain a model capability observation. Restart or
// model changes leave support unknown until the existing provider probe runs.
const observations = new WeakMap<object, { model: string; supported: boolean }>();
export function rememberHistoryToolSupport(owner: object, model: string, supported: boolean): void {
 observations.set(owner, { model, supported });
}
export function historyToolSupport(owner: object, model: string): boolean | undefined {
 const observation = observations.get(owner);
 return observation?.model === model ? observation.supported : undefined;
}
