import type { ToolDef } from '../core/types.js';
import { tools as navigationTools } from './navigation.js';
import { tools as snapshotTools } from './snapshot.js';
import { tools as interactionTools } from './interaction.js';
import { tools as mouseTools } from './mouse.js';
import { tools as captureTools } from './capture.js';
import { tools as tabsTools } from './tabs.js';
import { tools as storageTools } from './storage.js';
import { tools as batchTools } from './batch.js';

export const allTools: ToolDef[] = [
  ...navigationTools,
  ...snapshotTools,
  ...interactionTools,
  ...mouseTools,
  ...captureTools,
  ...tabsTools,
  ...storageTools,
  ...batchTools,
];

export const toolMap: Map<string, ToolDef> = new Map(allTools.map((t) => [t.name, t]));
