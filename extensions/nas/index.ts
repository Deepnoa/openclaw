import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolFactory,
} from "../../src/plugins/types.js";
import { createNasTools } from "./src/nas-tools.js";

export default function register(api: OpenClawPluginApi) {
  api.registerTool(
    ((ctx) => {
      if (ctx.sandboxed) {
        return null;
      }
      return createNasTools(api) as AnyAgentTool[];
    }) as OpenClawPluginToolFactory,
    { optional: true },
  );
}
