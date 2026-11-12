import { EventEmitter } from 'node:events'

/** In-process event bus. index.ts forwards every event to the renderer. */
class Bus extends EventEmitter {
  publish(type: string, payload: unknown = {}): void {
    this.emit('event', { type, payload })
  }
}
export const bus = new Bus()
bus.setMaxListeners(100)
