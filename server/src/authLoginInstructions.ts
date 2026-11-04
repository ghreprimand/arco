import type { AuthLoginResult } from '@arco/shared';

// Terminal fallback login remains operator-run. The host command works before any workflow exists.
export function authLoginInstructions(command: string, extra = '', deployment = process.env.ARCO_DEPLOYMENT): AuthLoginResult {
  if (deployment === 'docker') {
    return {
      started: false,
      command,
      hostCommand: `docker compose exec arco ${command}`,
      manual: `Run the Docker command in your computer's terminal from the Arco folder containing compose.yaml. Open the printed link in your browser. Login stays in Arco's data volume.${extra ? ` ${extra}` : ''}`,
    };
  }
  return {
    started: false,
    command,
    manual: `Run \`${command}\` in Arco's terminal (TOOLS > TERMINAL), or a shell on the server. Open the printed link on your device.${extra ? ` ${extra}` : ''}`,
  };
}
