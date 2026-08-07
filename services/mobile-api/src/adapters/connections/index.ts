/**
 * The provider registry, assembled.
 *
 * This is the only file that knows the full set of providers. Adding one means
 * a new file under `providers/` and a single `register` call here — nothing in
 * routes, the aggregator or the app changes.
 */
import { ProviderRegistry } from './provider.ts';
import { FRIGATE_DESCRIPTOR, FrigateProvider } from './providers/frigate.ts';
import { LOSTBLINK_DESCRIPTOR, LostblinkProvider } from './providers/lostblink.ts';
import { RTSP_DESCRIPTOR, RtspProvider } from './providers/rtsp.ts';

export function buildProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(FRIGATE_DESCRIPTOR, (ctx) => new FrigateProvider(ctx));
  registry.register(RTSP_DESCRIPTOR, (ctx) => new RtspProvider(ctx));
  registry.register(LOSTBLINK_DESCRIPTOR, (ctx) => new LostblinkProvider(ctx));
  return registry;
}

export { ProviderRegistry } from './provider.ts';
export type {
  CameraProvider,
  ProviderCapabilities,
  ProviderContext,
  ProviderDescriptor,
  ProviderField,
  ProbeResult,
} from './provider.ts';
export { namespaceId, parseNamespacedId, slugify } from './provider.ts';
export { AggregateOrionisAdapter } from './aggregate.ts';
export type { ActiveConnection } from './aggregate.ts';
export { ConnectionStore } from './store.ts';
export type {
  ConnectionRecord,
  ConnectionHealthRecord,
  CreateConnectionInput,
  UpdateConnectionInput,
} from './store.ts';
