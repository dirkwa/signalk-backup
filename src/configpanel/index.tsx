// Module Federation entry point — webpack uses this as the exposed module's
// entry. The default export from PluginConfigurationPanel is what the
// SignalK Admin UI mounts.

export { default as PluginConfigurationPanel } from './PluginConfigurationPanel'
