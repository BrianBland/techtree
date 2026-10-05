import type { MetricPlugin } from "../types.ts";
import { genericPlugin } from "./generic.ts";
import { gitPlugin } from "./git.ts";
import { rustPlugin } from "./rust.ts";
import { slopPlugin } from "./slop.ts";

/** The v1 metric plugins, in run order. */
export const defaultPlugins: MetricPlugin[] = [genericPlugin, gitPlugin, rustPlugin, slopPlugin];

export { genericPlugin, gitPlugin, rustPlugin, slopPlugin };
