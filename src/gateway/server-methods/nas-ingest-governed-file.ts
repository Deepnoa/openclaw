import { runGovernedIngestion, validateIngestRequest } from "../nas-ingest-governed-file-shared.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const nasIngestGovernedFileHandlers: GatewayRequestHandlers = {
  "nas.ingestGovernedFile": async ({ params, respond }) => {
    const p = (params ?? {}) as { path?: unknown; mode?: unknown; confirm?: unknown };
    const validated = validateIngestRequest(p.path, p.mode, p.confirm);
    if (!validated.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, validated.error));
      return;
    }
    const result = await runGovernedIngestion(validated.filePath, validated.mode);
    if (!result.ok) {
      const code =
        result.status === 400 || result.status === 403 || result.status === 404
          ? ErrorCodes.INVALID_REQUEST
          : ErrorCodes.UNAVAILABLE;
      respond(false, undefined, errorShape(code, result.error));
      return;
    }
    respond(
      true,
      {
        mode: result.mode,
        input_path: result.input_path,
        exit_code: result.exit_code,
        result: result.decision,
      },
      undefined,
    );
  },
};
