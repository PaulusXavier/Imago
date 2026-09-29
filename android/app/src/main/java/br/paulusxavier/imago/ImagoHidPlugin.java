package br.paulusxavier.imago;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothClass;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothHidDevice;
import android.bluetooth.BluetoothHidDeviceAppSdpSettings;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Faz o celular aparecer para o PC como um teclado + mouse Bluetooth (perfil HID Device).
 * O PC nao precisa de nenhum programa: o Windows enxerga um teclado comum.
 */
@CapacitorPlugin(
    name = "ImagoHid",
    permissions = {
        @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_CONNECT })
    }
)
public class ImagoHidPlugin extends Plugin {

    private static final int REPORT_KEYBOARD = 1;
    private static final int REPORT_MOUSE = 2;

    // Teclado (Report ID 1: 8 bytes) + Mouse relativo (Report ID 2: botoes, dx, dy).
    private static final byte[] DESCRIPTOR = new byte[] {
        // --- Teclado ---
        (byte) 0x05, (byte) 0x01, (byte) 0x09, (byte) 0x06, (byte) 0xA1, (byte) 0x01,
        (byte) 0x85, (byte) 0x01,
        (byte) 0x05, (byte) 0x07, (byte) 0x19, (byte) 0xE0, (byte) 0x29, (byte) 0xE7,
        (byte) 0x15, (byte) 0x00, (byte) 0x25, (byte) 0x01, (byte) 0x75, (byte) 0x01,
        (byte) 0x95, (byte) 0x08, (byte) 0x81, (byte) 0x02,
        (byte) 0x95, (byte) 0x01, (byte) 0x75, (byte) 0x08, (byte) 0x81, (byte) 0x01,
        (byte) 0x95, (byte) 0x05, (byte) 0x75, (byte) 0x01, (byte) 0x05, (byte) 0x08,
        (byte) 0x19, (byte) 0x01, (byte) 0x29, (byte) 0x05, (byte) 0x91, (byte) 0x02,
        (byte) 0x95, (byte) 0x01, (byte) 0x75, (byte) 0x03, (byte) 0x91, (byte) 0x01,
        (byte) 0x95, (byte) 0x06, (byte) 0x75, (byte) 0x08, (byte) 0x15, (byte) 0x00,
        (byte) 0x25, (byte) 0x65, (byte) 0x05, (byte) 0x07, (byte) 0x19, (byte) 0x00,
        (byte) 0x29, (byte) 0x65, (byte) 0x81, (byte) 0x00,
        (byte) 0xC0,
        // --- Mouse ---
        (byte) 0x05, (byte) 0x01, (byte) 0x09, (byte) 0x02, (byte) 0xA1, (byte) 0x01,
        (byte) 0x85, (byte) 0x02,
        (byte) 0x09, (byte) 0x01, (byte) 0xA1, (byte) 0x00,
        (byte) 0x05, (byte) 0x09, (byte) 0x19, (byte) 0x01, (byte) 0x29, (byte) 0x03,
        (byte) 0x15, (byte) 0x00, (byte) 0x25, (byte) 0x01, (byte) 0x95, (byte) 0x03,
        (byte) 0x75, (byte) 0x01, (byte) 0x81, (byte) 0x02,
        (byte) 0x95, (byte) 0x01, (byte) 0x75, (byte) 0x05, (byte) 0x81, (byte) 0x03,
        (byte) 0x05, (byte) 0x01, (byte) 0x09, (byte) 0x30, (byte) 0x09, (byte) 0x31,
        (byte) 0x15, (byte) 0x81, (byte) 0x25, (byte) 0x7F, (byte) 0x75, (byte) 0x08,
        (byte) 0x95, (byte) 0x02, (byte) 0x81, (byte) 0x06,
        (byte) 0xC0, (byte) 0xC0
    };

    private final ExecutorService sender = Executors.newSingleThreadExecutor();
    private BluetoothHidDevice hid;
    private BluetoothDevice host;
    private boolean registered = false;
    private boolean starting = false;

    private final BluetoothProfile.ServiceListener profileListener = new BluetoothProfile.ServiceListener() {
        @Override
        public void onServiceConnected(int profile, BluetoothProfile proxy) {
            if (profile == BluetoothProfile.HID_DEVICE) {
                hid = (BluetoothHidDevice) proxy;
                registerApp();
            }
        }

        @Override
        public void onServiceDisconnected(int profile) {
            if (profile == BluetoothProfile.HID_DEVICE) {
                hid = null;
                registered = false;
                host = null;
                starting = false;
                emitState();
            }
        }
    };

    private final BluetoothHidDevice.Callback hidCallback = new BluetoothHidDevice.Callback() {
        @Override
        public void onAppStatusChanged(BluetoothDevice pluggedDevice, boolean isRegistered) {
            registered = isRegistered;
            if (!isRegistered) host = null;
            emitState();
        }

        @Override
        public void onConnectionStateChanged(BluetoothDevice device, int state) {
            if (state == BluetoothProfile.STATE_CONNECTED) {
                host = device;
            } else if (state == BluetoothProfile.STATE_DISCONNECTED
                    && host != null && device != null && host.getAddress().equals(device.getAddress())) {
                host = null;
            }
            emitState();
        }
    };

    // ------------------------------------------------------------------ metodos JS

    /** Inicia o servico HID (pede a permissao de Bluetooth se precisar). */
    @PluginMethod
    public void start(PluginCall call) {
        if (needsPermission()) {
            requestPermissionForAlias("bluetooth", call, "startPermissionCallback");
            return;
        }
        startHid();
        call.resolve(status());
    }

    @PermissionCallback
    private void startPermissionCallback(PluginCall call) {
        if (needsPermission()) {
            call.reject("Permissão de Bluetooth negada. Ative em Configurações > Apps > Imago > Permissões.");
            return;
        }
        startHid();
        call.resolve(status());
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(status());
    }

    @PluginMethod
    public void openBluetoothSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_BLUETOOTH_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    /** Lista os aparelhos ja pareados (para o usuario escolher o computador). */
    @SuppressLint("MissingPermission")
    @PluginMethod
    public void listPaired(PluginCall call) {
        if (needsPermission()) {
            call.reject("Sem permissão de Bluetooth.");
            return;
        }
        JSArray list = new JSArray();
        BluetoothAdapter adapter = adapter();
        if (adapter != null) {
            Set<BluetoothDevice> bonded = adapter.getBondedDevices();
            for (BluetoothDevice d : bonded) {
                JSObject o = new JSObject();
                o.put("name", d.getName() != null ? d.getName() : d.getAddress());
                o.put("address", d.getAddress());
                BluetoothClass cls = d.getBluetoothClass();
                o.put("isComputer", cls != null && cls.getMajorDeviceClass() == BluetoothClass.Device.Major.COMPUTER);
                list.put(o);
            }
        }
        JSObject result = new JSObject();
        result.put("devices", list);
        call.resolve(result);
    }

    /** Conecta ao computador pareado (address opcional; sem ele, escolhe o primeiro computador pareado). */
    @SuppressLint("MissingPermission")
    @PluginMethod
    public void connect(PluginCall call) {
        if (needsPermission()) {
            call.reject("Sem permissão de Bluetooth.");
            return;
        }
        if (hid == null || !registered) {
            startHid();
            call.reject("O Bluetooth ainda está iniciando. Tente de novo em 2 segundos.");
            return;
        }
        BluetoothAdapter adapter = adapter();
        if (adapter == null) {
            call.reject("Este aparelho não tem Bluetooth.");
            return;
        }
        BluetoothDevice target = null;
        String address = call.getString("address");
        if (address != null && !address.isEmpty()) {
            target = adapter.getRemoteDevice(address);
        } else {
            for (BluetoothDevice d : adapter.getBondedDevices()) {
                BluetoothClass cls = d.getBluetoothClass();
                if (cls != null && cls.getMajorDeviceClass() == BluetoothClass.Device.Major.COMPUTER) {
                    target = d;
                    break;
                }
            }
        }
        if (target == null) {
            call.reject("Nenhum computador pareado. Pareie o celular com o PC nas configurações de Bluetooth.");
            return;
        }
        boolean ok = hid.connect(target);
        if (!ok) {
            call.reject("O PC recusou a conexão. Confira o pareamento no Windows e tente de novo.");
            return;
        }
        call.resolve(status());
    }

    @SuppressLint("MissingPermission")
    @PluginMethod
    public void disconnect(PluginCall call) {
        if (hid != null && host != null) hid.disconnect(host);
        host = null;
        call.resolve(status());
    }

    /** Envia uma tecla: usage = codigo HID (pagina 0x07), modifiers = bits (Ctrl=1, Shift=2, Alt=4). */
    @PluginMethod
    public void sendKey(final PluginCall call) {
        final int usage = call.getInt("usage", 0);
        final int modifiers = call.getInt("modifiers", 0);
        sender.execute(new Runnable() {
            @Override
            public void run() {
                if (!ready(call)) return;
                tap(usage, modifiers);
                call.resolve();
            }
        });
    }

    /** Envia varias teclas em sequencia: keys = [{usage, modifiers}, ...]. */
    @PluginMethod
    public void sendKeys(final PluginCall call) {
        final JSArray keys = call.getArray("keys");
        sender.execute(new Runnable() {
            @Override
            public void run() {
                if (!ready(call)) return;
                try {
                    if (keys != null) {
                        for (int i = 0; i < keys.length(); i++) {
                            org.json.JSONObject k = keys.getJSONObject(i);
                            tap(k.optInt("usage", 0), k.optInt("modifiers", 0));
                            Thread.sleep(25);
                        }
                    }
                    call.resolve();
                } catch (Exception e) {
                    call.reject("Falha ao enviar teclas: " + e.getMessage());
                }
            }
        });
    }

    /** Move o mouse (relativo). Valores grandes sao divididos em passos de ate 127. */
    @PluginMethod
    public void mouseMove(final PluginCall call) {
        final int dx = Math.round(call.getFloat("dx", 0f));
        final int dy = Math.round(call.getFloat("dy", 0f));
        sender.execute(new Runnable() {
            @Override
            public void run() {
                if (!ready(call)) return;
                int rx = dx;
                int ry = dy;
                while (rx != 0 || ry != 0) {
                    int sx = Math.max(-127, Math.min(127, rx));
                    int sy = Math.max(-127, Math.min(127, ry));
                    send(REPORT_MOUSE, new byte[] { 0, (byte) sx, (byte) sy });
                    rx -= sx;
                    ry -= sy;
                }
                call.resolve();
            }
        });
    }

    /** Clique do mouse (botao esquerdo por padrao; button: 1=esquerdo, 2=direito). */
    @PluginMethod
    public void mouseClick(final PluginCall call) {
        final int button = call.getInt("button", 1);
        sender.execute(new Runnable() {
            @Override
            public void run() {
                if (!ready(call)) return;
                send(REPORT_MOUSE, new byte[] { (byte) button, 0, 0 });
                try { Thread.sleep(30); } catch (InterruptedException ignored) { }
                send(REPORT_MOUSE, new byte[] { 0, 0, 0 });
                call.resolve();
            }
        });
    }

    /** Liga/desliga o uso dos botoes de volume como proximo/anterior. */
    @PluginMethod
    public void setVolumeKeys(PluginCall call) {
        MainActivity.volumeKeysEnabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        call.resolve();
    }

    // ------------------------------------------------------------------ internos

    private boolean needsPermission() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && getPermissionState("bluetooth") != PermissionState.GRANTED;
    }

    private BluetoothAdapter adapter() {
        BluetoothManager manager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return manager != null ? manager.getAdapter() : null;
    }

    @SuppressLint("MissingPermission")
    private void startHid() {
        if (hid != null) {
            registerApp();
            return;
        }
        if (starting) return;
        BluetoothAdapter adapter = adapter();
        if (adapter == null) return;
        starting = adapter.getProfileProxy(getContext(), profileListener, BluetoothProfile.HID_DEVICE);
    }

    @SuppressLint("MissingPermission")
    private void registerApp() {
        if (hid == null || registered) return;
        BluetoothHidDeviceAppSdpSettings sdp = new BluetoothHidDeviceAppSdpSettings(
                "Imago",
                "Controle de apresentação",
                "Imago",
                BluetoothHidDevice.SUBCLASS1_COMBO,
                DESCRIPTOR
        );
        hid.registerApp(sdp, null, null, Executors.newSingleThreadExecutor(), hidCallback);
    }

    private boolean ready(PluginCall call) {
        if (hid == null || host == null) {
            call.reject("Não conectado ao PC por Bluetooth.");
            return false;
        }
        return true;
    }

    private void tap(int usage, int modifiers) {
        send(REPORT_KEYBOARD, new byte[] { (byte) modifiers, 0, (byte) usage, 0, 0, 0, 0, 0 });
        send(REPORT_KEYBOARD, new byte[8]);
    }

    @SuppressLint("MissingPermission")
    private void send(int reportId, byte[] data) {
        BluetoothHidDevice h = hid;
        BluetoothDevice d = host;
        if (h != null && d != null) h.sendReport(d, reportId, data);
    }

    @SuppressLint("MissingPermission")
    private JSObject status() {
        JSObject o = new JSObject();
        String state;
        String message;
        if (needsPermission()) {
            state = "no-permission";
            message = "Permita o Bluetooth para o Imago.";
        } else if (adapter() == null) {
            state = "unsupported";
            message = "Este aparelho não tem Bluetooth.";
        } else if (host != null) {
            state = "connected";
            message = "Conectado ao computador.";
        } else if (hid != null && registered) {
            state = "ready";
            message = "Pronto. Pareie com o PC (ou toque em Conectar se já está pareado).";
        } else {
            state = "starting";
            message = "Iniciando Bluetooth…";
        }
        o.put("state", state);
        o.put("message", message);
        if (host != null) {
            o.put("hostName", host.getName());
            o.put("hostAddress", host.getAddress());
        }
        return o;
    }

    private void emitState() {
        notifyListeners("state", status());
    }
}
