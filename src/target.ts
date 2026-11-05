import type { BuiltinDeps } from "./builtin.ts"
import type { Delivery, DeliveryResult } from "./engine.ts"
import { deliverViaHc, hcTerminalExists, hcTerminalState, isHcTarget } from "./hc.ts"
import type { Store } from "./store.ts"
import { deliverViaOpencode, probeCapacity, runProbe, sessionExists, sessionState } from "./system.ts"

/** A watch's target: an OpenCode session (`ses_…`) or a Herdr terminal (`hc:<terminal>`). */
export const isTarget = (target: string) => /^ses_[A-Za-z0-9]+$/.test(target) || isHcTarget(target)

export const deliverToTarget = (delivery: Delivery): Promise<DeliveryResult> =>
  isHcTarget(delivery.sessionID) ? deliverViaHc(delivery) : deliverViaOpencode(delivery)

export const targetExists = (target: string) => (isHcTarget(target) ? hcTerminalExists(target) : sessionExists(target))

export const targetState = (target: string) => (isHcTarget(target) ? hcTerminalState(target) : sessionState(target))

export const builtinDeps = (store: Store): BuiltinDeps => ({
  capacity: probeCapacity,
  sessionState: targetState,
  watchStatus: (ref) => store.find(ref)?.status,
  exec: runProbe,
})
