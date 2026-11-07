// A completion may write state only while it still belongs to the latest read.
export function requestGeneration(): () => () => boolean {
  let generation = 0;
  return () => {
    const current = ++generation;
    return () => current === generation;
  };
}
