package br.paulusxavier.imago;

import android.os.Bundle;
import android.view.KeyEvent;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** Quando true, os botoes de volume viram proximo/anterior (ligado pelo JS durante a apresentacao). */
    public static volatile boolean volumeKeysEnabled = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ImagoHidPlugin.class);
        super.onCreate(savedInstanceState);
        // Tela do celular nao apaga durante a apresentacao.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        if (volumeKeysEnabled && (code == KeyEvent.KEYCODE_VOLUME_UP || code == KeyEvent.KEYCODE_VOLUME_DOWN)) {
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0 && getBridge() != null) {
                String dir = code == KeyEvent.KEYCODE_VOLUME_UP ? "up" : "down";
                getBridge().triggerWindowJSEvent("imagoVolume", "{\"dir\":\"" + dir + "\"}");
            }
            return true; // consome o evento (nao muda o volume)
        }
        return super.dispatchKeyEvent(event);
    }
}
