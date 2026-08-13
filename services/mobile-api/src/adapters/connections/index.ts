/**
 * The provider registry, assembled.
 *
 * This is the only file that knows the full set of providers. Adding one means
 * a new file under `providers/` and a single `register` call here — nothing in
 * routes, the aggregator or the app changes.
 */
import { ProviderRegistry } from './provider.ts';
import { ARLO_DESCRIPTOR, ArloProvider } from './providers/arlo.ts';
import { AXIS_DESCRIPTOR, AxisProvider } from './providers/axis.ts';
import { DAHUA_DESCRIPTOR, DahuaProvider } from './providers/dahua.ts';
import { EUFY_DESCRIPTOR, EufyProvider } from './providers/eufy.ts';
import { FOSCAM_DESCRIPTOR, FoscamProvider } from './providers/foscam.ts';
import { FRIGATE_DESCRIPTOR, FrigateProvider } from './providers/frigate.ts';
import { HANWHA_DESCRIPTOR, HanwhaProvider } from './providers/hanwha.ts';
import { HIKVISION_DESCRIPTOR, HikvisionProvider } from './providers/hikvision.ts';
import {
  forgetSeenCameras,
  LOSTBLINK_DESCRIPTOR,
  LostblinkProvider,
} from './providers/lostblink.ts';
import { NEST_DESCRIPTOR, NestProvider } from './providers/nest.ts';
import { ONVIF_DESCRIPTOR, OnvifProvider } from './providers/onvif.ts';
import { REOLINK_DESCRIPTOR, ReolinkProvider } from './providers/reolink.ts';
import { RING_DESCRIPTOR, RingProvider } from './providers/ring.ts';
import { RTSP_DESCRIPTOR, RtspProvider } from './providers/rtsp.ts';
import { SCRYPTED_DESCRIPTOR, ScryptedProvider } from './providers/scrypted.ts';
import { TAPO_DESCRIPTOR, TapoProvider } from './providers/tapo.ts';
import { UNIFI_DESCRIPTOR, UnifiProvider } from './providers/unifi.ts';
import { UNIVIEW_DESCRIPTOR, UniviewProvider } from './providers/uniview.ts';
import { VIVOTEK_DESCRIPTOR, VivotekProvider } from './providers/vivotek.ts';
import { WYZE_DESCRIPTOR, WyzeProvider } from './providers/wyze.ts';

export function buildProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(FRIGATE_DESCRIPTOR, (ctx) => new FrigateProvider(ctx));
  registry.register(RTSP_DESCRIPTOR, (ctx) => new RtspProvider(ctx));
  registry.register(SCRYPTED_DESCRIPTOR, (ctx) => new ScryptedProvider(ctx));
  registry.register(LOSTBLINK_DESCRIPTOR, (ctx) => new LostblinkProvider(ctx), forgetSeenCameras);
  registry.register(UNIFI_DESCRIPTOR, (ctx) => new UnifiProvider(ctx));
  registry.register(TAPO_DESCRIPTOR, (ctx) => new TapoProvider(ctx));
  registry.register(REOLINK_DESCRIPTOR, (ctx) => new ReolinkProvider(ctx));
  registry.register(DAHUA_DESCRIPTOR, (ctx) => new DahuaProvider(ctx));
  registry.register(HIKVISION_DESCRIPTOR, (ctx) => new HikvisionProvider(ctx));
  registry.register(AXIS_DESCRIPTOR, (ctx) => new AxisProvider(ctx));
  registry.register(FOSCAM_DESCRIPTOR, (ctx) => new FoscamProvider(ctx));
  registry.register(VIVOTEK_DESCRIPTOR, (ctx) => new VivotekProvider(ctx));
  registry.register(UNIVIEW_DESCRIPTOR, (ctx) => new UniviewProvider(ctx));
  registry.register(HANWHA_DESCRIPTOR, (ctx) => new HanwhaProvider(ctx));
  registry.register(ONVIF_DESCRIPTOR, (ctx) => new OnvifProvider(ctx));
  registry.register(WYZE_DESCRIPTOR, (ctx) => new WyzeProvider(ctx));
  registry.register(RING_DESCRIPTOR, (ctx) => new RingProvider(ctx));
  registry.register(EUFY_DESCRIPTOR, (ctx) => new EufyProvider(ctx));
  registry.register(ARLO_DESCRIPTOR, (ctx) => new ArloProvider(ctx));
  registry.register(NEST_DESCRIPTOR, (ctx) => new NestProvider(ctx));
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
