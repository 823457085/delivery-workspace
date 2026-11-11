import { applyPluginEnvironment, readPluginFile, pluginFile } from './store.mjs';
applyPluginEnvironment(await readPluginFile(pluginFile()), process.env);
