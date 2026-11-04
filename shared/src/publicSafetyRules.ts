export const publicSafetyRules = [
  ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/],
  ['provider-token', /\b(?:sk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16})\b/],
  ['credential-assignment', /\b(?:api_key|apiKey|access_token|refresh_token|client_secret)\s*[=:]\s*["'][A-Za-z0-9_./+\-=]{32,}["']/],
] as const;
