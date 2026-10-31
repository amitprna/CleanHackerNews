const cache = new Map();
const TTL_MS = 5 * 60 * 1000;

/**
 * Read an SSM SecureString, cached for a few minutes per Lambda container.
 * `envOverride` lets local scripts supply the value directly.
 */
export async function getSecret(paramName, envOverride) {
  if (envOverride && process.env[envOverride]) return process.env[envOverride];
  const hit = cache.get(paramName);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
  const ssm = new SSMClient({});
  const { Parameter } = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
  cache.set(paramName, { value: Parameter.Value, at: Date.now() });
  return Parameter.Value;
}
