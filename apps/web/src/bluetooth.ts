import { bluetoothSysExPackets, createBluetoothMidiInput } from './ble-midi';
import { isPopuPiano, type BluetoothLightingOutput } from './lighting';

const midiService = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
const midiCharacteristic = '7772e5db-3868-4112-a1a9-f2669d106bf3';

export function chooseBluetoothPiano(): Promise<BluetoothDevice> {
  return navigator.bluetooth.requestDevice({
    filters: [{ services: [midiService] }, { namePrefix: 'Popu' }, { namePrefix: 'POPU' }, { namePrefix: 'popu' }],
    optionalServices: [midiService],
  });
}

export interface BluetoothMidiConnection {
  name: string;
  output?: BluetoothLightingOutput;
  disconnect(): void;
}

export async function connectBluetoothPiano(
  device: BluetoothDevice,
  receive: (message: Uint8Array) => void,
  onDisconnect: () => void,
): Promise<BluetoothMidiConnection> {
  const gatt = device.gatt;
  if (!gatt) throw new Error('This device has no Bluetooth GATT server.');
  const input = createBluetoothMidiInput(receive);
  let characteristic: BluetoothRemoteGATTCharacteristic | undefined;
  let active = true;
  function notification(): void {
    const value = characteristic?.value;
    if (active && value) input.read(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  function detach(): void {
    active = false;
    input.clear();
    characteristic?.removeEventListener('characteristicvaluechanged', notification);
    device.removeEventListener('gattserverdisconnected', disconnected);
  }
  function disconnected(): void {
    detach();
    onDisconnect();
  }
  device.addEventListener('gattserverdisconnected', disconnected);
  try {
    const server = await gatt.connect();
    const service = await server.getPrimaryService(midiService);
    const io = await service.getCharacteristic(midiCharacteristic);
    characteristic = io;
    if (io.properties.read) await io.readValue();
    io.addEventListener('characteristicvaluechanged', notification);
    await io.startNotifications();
    if (!active || !gatt.connected) throw new Error('The keyboard disconnected during setup.');

    let output: BluetoothLightingOutput | undefined;
    if (isPopuPiano(device.name) && (io.properties.writeWithoutResponse || io.properties.write)) {
      let writes = Promise.resolve();
      let nextFrameAt = 0;
      output = {
        id: 'bluetooth:' + device.id,
        get state() { return active && gatt.connected ? 'connected' : 'disconnected'; },
        sendFrames(frames, signal) {
          // A SysEx message owns the characteristic until its final fragment is written.
          const send = writes.then(async () => {
            for (const frame of frames) {
              const delay = nextFrameAt - performance.now();
              if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
              if (signal?.aborted) return;
              for (const packet of bluetoothSysExPackets(frame, performance.now())) {
                if (!active || !gatt.connected) throw new Error('Bluetooth disconnected.');
                if (io.properties.writeWithoutResponse) await io.writeValueWithoutResponse(packet);
                else await io.writeValueWithResponse(packet);
              }
              nextFrameAt = performance.now() + 25;
            }
          });
          writes = send.catch(() => {});
          return send;
        },
      };
    }
    return {
      name: device.name || 'MIDI keyboard',
      output,
      disconnect() {
        detach();
        gatt.disconnect();
      },
    };
  } catch (error) {
    detach();
    if (gatt.connected) gatt.disconnect();
    throw error;
  }
}
