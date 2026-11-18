# PopuConnect Desktop

A WinForms utility for connecting PopuPiano over USB or Bluetooth MIDI and controlling the lights on its 29-key main module (C3–E5). The self-contained Windows x64 executable runs without a separate .NET installation.

## Requirements

- USB uses the Windows MIDI API when Windows exposes a USB MIDI output for the keyboard. Use a USB cable that supports data.
- Bluetooth lighting works without `midi.exe` when Windows exposes a MIDI output for the paired keyboard. For CLI-managed connections, use Windows 11 25H2 or later, the `MidiSrv` service, the Bluetooth LE MIDI transport, and Microsoft's tools. Manual BLE battery checks use Windows GATT and work without the CLI. [Windows MIDI Services Tools](https://github.com/microsoft/MIDI/releases)
- At startup, PopuConnect looks up `midi.exe` from the installer's `MidiConsole` registry entry, then in `%ProgramFiles%\Windows MIDI Services\Tools` and `PATH`. CLI mode requires `enumerate endpoints --show-endpoint-id` and `sysex send-file`. Bluetooth also requires `bluetooth connect` and `bluetooth customize --keep-when-offline`.

## Launch and connect

1. Connect the USB cable or turn on Bluetooth on the keyboard. Run `artifacts/win-x64/PopuConnect.exe`.
2. Select your keyboard in the combined list. Check the `[USB]` or `[Bluetooth]` label and the ID, especially if several keyboards are available.
3. Select **Connect / Retry**. For USB, the app checks the endpoint Windows already exposes. For **Bluetooth · Windows**, it opens the Windows MIDI output. In Bluetooth CLI mode, it creates a persistent connection and configures Windows to keep the endpoint when the keyboard goes offline.
4. Wait for **output ready**. The app selects the saved device at startup when Windows exposes the same port.

The list refreshes about every two seconds while the app is idle. With the CLI it uses `midi enumerate endpoints --show-endpoint-id` and `midi bluetooth list`. Otherwise it lists Windows USB and Bluetooth MIDI outputs. To identify the Bluetooth route, the app checks the MIDI Services transport, the paired BLE device's container, or a Bluetooth LE PnP ancestor.

**Prefer USB automatically** selects the saved USB endpoint and falls back to the saved Bluetooth device when USB is unplugged. Select the USB port manually the first time. Manual selection pins the connection and clears the preference checkbox. The app saves this choice. Re-enable the checkbox to resume automatic switching. Selecting USB preserves the saved Bluetooth device and MIDI endpoint IDs.

Without the CLI, open **Diagnostics and manual IDs → Windows MIDI ports** to see the names and IDs of confirmed output ports.

### Wireless use with MIDIberry and loopMIDI

Unplug USB, turn on the paired PopuPiano, and open MIDIberry. Select the PopuPiano input and loopMIDI output in MIDIberry, then enable that loopMIDI port in FL Studio. In PopuConnect without the CLI, select **Refresh devices**, choose **Bluetooth · Windows**, then select **Connect / Retry** and check **Turn off lights**. PopuConnect keeps the Windows SysEx output open as long as the selected port stays available. It releases the output when you switch devices, the port disappears, or you close the app. Diagnostics show open and release events. MIDIberry continues to route notes to FL Studio. [BLE MIDI in WinRT](https://blogs.windows.com/windowsdeveloper/2016/09/21/midi-enhancements-in-windows-10/) · [Windows MIDI API compatibility](https://microsoft.github.io/MIDI/kb/api-back-compat/)

### Manual IDs and CLI commands

With the CLI installed, **CLI output** is available under **Diagnostics and manual IDs**. For USB, paste the MIDI endpoint ID from `midi enumerate endpoints --show-endpoint-id` into the second field. For Bluetooth, paste the address from `midi bluetooth list` into the first field. Use the second field to specify an exact MIDI output endpoint when needed. Select **Validate and save IDs**.

```powershell
midi bluetooth status
midi service status
midi bluetooth list
midi bluetooth connect <bluetooth-device-id>
midi bluetooth customize <bluetooth-device-id> --keep-when-offline always
midi enumerate endpoints --show-endpoint-id
midi sysex send-file <file.syx> "<midi-endpoint-id>"
```

The app checks the relevant commands with `--help` before connecting. Bluetooth-only checks cover Bluetooth availability and endpoint persistence. USB discovery continues if `midi bluetooth list` fails.

Windows MIDI Services manages reconnection after the window closes. MIDI availability in FL Studio depends on the system service and the DAW's MIDI API. Use the DAW and its MIDI routing tools to configure note input.

## Lighting

- **Turn off lights** sends two SysEx frames to the same output. The frame starting with `F0 03 20 1D` turns off the main module's 29 keys. The frame starting with `F0 04 20 18` turns off ExtraPiano's 24 keys.
- **Choose color…** opens the color dialog. **Apply to all keys** sends the palette frame `F0 03 1E 01 01 R G B F7` and assigns slot 1 to every main-module key. Color components are converted from 0–255 to 0–127, rounding halves up.
- **Turn off main module lights on connect** sends the command once when a USB output or confirmed Bluetooth connection becomes ready. It sends again after an observed reconnect or a change of selected connection. The manual button is available after an automatic send fails.

**Command sent.** means the CLI completed or the Windows MIDI port accepted the command. Check the LEDs on the instrument for the result. The app sends frames in sequence.

### Magnetic extension

On 18 November 2026, the 53-byte frame `F0 04 20 18 [00 00 … 17 00] F7` turned off all 24 ExtraPiano keys over USB MIDI on a PopuPiano with `VID_2CF9&PID_001F`. The same MIDI output handled both modules, and the slot-0 frame worked on its own. LED Lab uses the same module byte `04`, command `20`, and key indices 0–23. **Turn off lights** sends both verified frames without requiring an extension selection. [PopuPiano LED specification](https://github.com/allen4z/PartykeysProtocol/blob/2ea97de315aeb1e151c8e39dcff258f4cc8147ad/popupiano_LED_PROTOCOL.md) · [LED Lab frame encoding](https://github.com/nachovy/PopuPiano-Visualization-Customizer/blob/6904d2d3c1d541d7b94f955ba2d796973f71ee37/midi_server.py#L109-L128)

## Battery checks and diagnostics

Select a source under **Battery** and select **Check battery**. The app reports a percentage when a supported interface returns a valid value.

**USB.** The app maps the selected MIDI endpoint to the physical USB device through Windows PnP, using the driver interface where needed. Diagnostics record the VID/PID, MI interface number, class GUIDs, and Class/SubClass/Prot from Windows compatible IDs. The battery check looks for `System.Devices.BatteryLife`, reads an individual Windows BatteryReport where available, and computes a percentage from valid remaining and full capacity values. The check is scoped to the keyboard's USB device tree. [USB identifiers](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/standard-usb-identifiers) · [BatteryLife property](https://learn.microsoft.com/en-us/windows/win32/properties/props-system-devices-batterylife) · [Individual battery reports](https://learn.microsoft.com/en-us/windows/apps/develop/devices-sensors/get-battery-info)

If Windows exposes HID collections, diagnostics include their report types, lengths, IDs, and declared usage ranges. The app normalizes the logical range for numeric Battery Strength (`06/20`) and accepts 0–100 for Relative and Absolute State of Charge (`85/64`, `85/65`). It reads declared Input and Feature battery fields and reports when Windows blocks access to a collection. [Microsoft HID report parser](https://learn.microsoft.com/en-us/windows-hardware/drivers/hid/interpreting-hid-reports) · [HID Usage Tables, §9.2](https://usb.org/sites/default/files/hut1_3_0.pdf) · [HID Power Devices, §4.2.5](https://www.usb.org/sites/default/files/pdcv10.pdf)

**Bluetooth.** Choose **Bluetooth (BLE)**. When the selected MIDI route is USB, the app offers a separate BLE device picker. The manual check performs uncached discovery for standard Battery Service `180F` and reads characteristic `2A19` if it is readable. A valid reading is one byte from 0 to 100. The app reports an absent service separately from radio, permission, GATT/ATT, and timeout errors, and records the source and time of a successful reading. The check can establish a BLE connection and preserves the selected MIDI route. [Bluetooth SIG Battery Service](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/BAS_v1.1/out/en/index-en.html) · [Windows GATT client](https://learn.microsoft.com/en-us/windows/uwp/devices-sensors/gatt-client)

### Diagnostic reports

Select **Collect device diagnostics** and **Export diagnostics** to save a local text report with the application and Windows versions, MIDI service state, endpoints, API results, recent errors, and SysEx transmission records. The report includes the latest manual BLE battery check. Device IDs and arbitrary names are replaced with consistent session labels. **Local log and manual IDs** shows the original addresses and CLI output for local configuration.

### Record USB SysEx

Select a connected USB PopuPiano, open **Diagnostics and manual IDs → Report preview**, and select **Record USB SysEx**. The recorder opens the matching Windows MIDI input and reopens it when the device returns. **Stop recording** releases the input. The exported report includes timestamps, direction, port labels, lengths, and hex for complete SysEx frames. It counts other MIDI messages and records outgoing lighting commands as TX requests. The in-memory log holds up to 256 KiB of text and counts omitted lines. If the driver cannot share its input, close the other MIDI app and retry. [WinRT MIDI message model](https://learn.microsoft.com/en-us/uwp/api/windows.devices.midi.imidimessage)

## Settings and compatibility

Settings are stored in `%LOCALAPPDATA%/PopuConnect/settings.json`. Existing keys `BluetoothDeviceId`, `MidiEndpointId`, `DeviceName`, and lighting and startup options retain their meanings. USB selection uses `UsbEndpointId`, `UsbDeviceInstanceId`, and `UsbDeviceName`. `ConnectionPreference` is 0 for automatic, 1 for Bluetooth, and 2 for USB. Existing settings files load with automatic USB preference by default. Saves use a temporary file. The app reports invalid JSON in diagnostics.

- CLI discovery extracts identifiers and uses Windows metadata to confirm the transport. USB discovery checks transport metadata, the driver interface path, or a physical USB PnP ancestor. Manual refresh can also discover BLE device names.
- Windows MIDI Services WinRT outputs are matched to their UMP endpoints through AssociatedUMP. Group 1 output is supported. For direct USB MIDI 1.0, the app uses the system output port ID and validates the selected endpoint and instance ID before sending.
- For Bluetooth, the app checks `BluetoothLEDevice.ConnectionStatus` even when the endpoint is saved. For USB, it checks the current endpoint and output. A very short disconnect between checks can go unnoticed. Verify SysEx delivery on the instrument.
- **Connect on startup** controls PopuConnect's startup behavior. Windows can restore a previously saved persistent connection on its own.
- Desktop applies one color to the main module. `PopuPianoLighting.Keys` accepts individual key indices and slots 0–127. The color button overwrites slot 1.

## Build and verification

From the repository root, use the .NET 10 LTS SDK specified in `global.json`. Desktop uses .NET, WinForms, and the Windows SDK projection. xUnit is used for tests.

```powershell
dotnet build -c Release
dotnet test -c Release
dotnet publish apps/desktop/src/PopuConnect/PopuConnect.csproj -c Release -r win-x64 --self-contained true -o artifacts/win-x64
powershell -NoProfile -ExecutionPolicy Bypass -File apps/desktop/scripts/Smoke-Ui.ps1
```

The smoke test launches the published EXE in an interactive Windows session without a selected keyboard. It checks that lighting controls are disabled and that the saved diagnostic report matches the preview. The report and screenshots go to `artifacts/qa/`.

Automated tests cover SysEx formats, boundary values, endpoint selection, settings compatibility, CLI failures and timeouts, cancellation, send ordering, temporary file cleanup, reconnects, USB and Bluetooth preference, battery result interpretation, USB device matching, and report redaction.

On Windows 11 with a PopuPiano, verify USB and Bluetooth discovery, automatic USB preference, the fallback to Bluetooth on unplug, manual selection, lights-off on both connections, and FL Studio notes after closing the window. Include reconnects, a disabled Bluetooth radio, disconnects during sending, and multiple similar devices. To verify lights-off over USB, check the main module's 29 keys and ExtraPiano's 24 keys separately.

## References

- [Microsoft MIDI Console](https://microsoft.github.io/MIDI/tools/console/)
- [Microsoft Windows MIDI SysEx Utility](https://microsoft.github.io/MIDI/tools/midisysextool/)
- [PopuPiano LED protocol](https://github.com/allen4z/PartykeysProtocol/blob/main/popupiano_LED_PROTOCOL.md)
- [Microsoft Bluetooth MIDI transport source](https://github.com/microsoft/MIDI/tree/aab296e3b016c15ba6296bd5eb46cab623b976b7/src/in-box/Transport/BluetoothMidiTransport)
- [MIDI Services property keys](https://github.com/microsoft/MIDI/blob/aab296e3b016c15ba6296bd5eb46cab623b976b7/src/in-box/Inc/MidiDefs.h)
