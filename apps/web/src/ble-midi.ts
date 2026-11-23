const clockPeriod = 8192; // The instrument clock uses 13 bits, in milliseconds.

// BLE-MIDI running status is local to one notification. Only SysEx can span packets.
export function readBluetoothMidi(packet: Uint8Array, receive: (message: Uint8Array, timestamp: number) => void): void {
  if (packet.length < 2 || (packet[0] & 0xc0) !== 0x80) return;
  let position = 1;
  let runningStatus = 0;
  let inSysEx = packet[position] < 0x80;
  let timestampHigh = (packet[0] & 0x3f) << 7;
  let timestamp = timestampHigh;

  while (position < packet.length) {
    let status = runningStatus;
    if (packet[position] >= 0x80) {
      const low = packet[position++] & 0x7f;
      if (low < (timestamp & 0x7f)) timestampHigh = (timestampHigh + 128) % clockPeriod;
      timestamp = timestampHigh + low;
      if (position === packet.length) return;
      if (packet[position] >= 0x80) {
        status = packet[position++];
        if (status >= 0xf8) continue; // Real-time messages may interrupt SysEx.
        inSysEx = status === 0xf0;
        if (inSysEx || status === 0xf7) continue;
        if (status < 0xf0) runningStatus = status;
      }
    }
    // A continuation can also start with a timestamped clock followed by SysEx data.
    if (inSysEx || !status) {
      while (position < packet.length && packet[position] < 0x80) position++;
      continue;
    }
    let length = 2;
    if ((status & 0xe0) === 0xc0 || status === 0xf1 || status === 0xf3) length = 1;
    else if (status >= 0xf0 && status !== 0xf2) length = 0;
    const end = position + length;
    if (end > packet.length) return;
    const data = packet.subarray(position, end);
    if (data.some(byte => byte >= 0x80)) return;
    if (status < 0xf0) receive(Uint8Array.of(status, ...data), timestamp);
    position = end;
  }
}

export function createBluetoothMidiInput(receive: (message: Uint8Array) => void) {
  const queue: { message: Uint8Array; at: number }[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previousTimestamp: number | undefined;
  let previousTime = 0;

  function deliver(): void {
    timer = undefined;
    while (queue.length) {
      const delay = queue[0].at - performance.now();
      if (delay > 0) {
        timer = setTimeout(deliver, Math.ceil(delay));
        return;
      }
      receive(queue.shift()!.message);
    }
  }

  return {
    read(packet: Uint8Array): void {
      const arrived = performance.now();
      readBluetoothMidi(packet, (message, timestamp) => {
        let at = Math.max(arrived, previousTime);
        if (previousTimestamp !== undefined) {
          const elapsed = (timestamp - previousTimestamp + clockPeriod) % clockPeriod;
          // After a long silence or clock reset, the wrap count is ambiguous. Re-anchor on arrival.
          if (arrived - previousTime < clockPeriod / 2 && elapsed < clockPeriod / 2) {
            at = Math.max(at, previousTime + elapsed);
          }
        }
        queue.push({ message, at });
        previousTimestamp = timestamp;
        previousTime = at;
      });
      if (timer === undefined) deliver();
    },
    clear(): void {
      clearTimeout(timer);
      timer = undefined;
      queue.length = 0;
      previousTimestamp = undefined;
      previousTime = 0;
    },
  };
}

export function bluetoothSysExPackets(frame: readonly number[], time: number): Uint8Array<ArrayBuffer>[] {
  if (frame[0] !== 0xf0 || frame.at(-1) !== 0xf7) throw new Error('Expected a complete SysEx frame.');
  // Web Bluetooth does not expose the negotiated MTU. 20 bytes fit the minimum ATT MTU.
  const capacity = 20;
  const header = 0x80 | ((Math.floor(time) >> 7) & 0x3f);
  const timestamp = 0x80 | (Math.floor(time) & 0x7f);
  const packets: Uint8Array<ArrayBuffer>[] = [];
  let packet = [header, timestamp, 0xf0];
  for (const byte of frame.slice(1, -1)) {
    if (packet.length === capacity) {
      packets.push(Uint8Array.from(packet));
      packet = [header];
    }
    packet.push(byte);
  }
  if (packet.length + 2 > capacity) {
    packets.push(Uint8Array.from(packet));
    packet = [header];
  }
  packet.push(timestamp, 0xf7);
  packets.push(Uint8Array.from(packet));
  return packets;
}
