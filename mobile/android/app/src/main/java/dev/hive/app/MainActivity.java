package dev.hive.app;

import android.graphics.Color;
import android.os.Bundle;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

/**
 * A full-screen WebView on your hive (hive web, reached over Tailscale). The address is asked for
 * once by the app's own page (assets/public/index.html) and kept there. Capacitor turns the page's
 * mic request (dictation) into Android's permission prompt and shows error.html when the address doesn't load.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (getBridge() == null) return; // no WebView on this device (Capacitor shows its own message)
        getBridge().getWebView().addJavascriptInterface(new HiveAndroid(), "HiveAndroid");
        // Back: close what the page opened (it adds a history entry per sheet / dialog), then step back
        // through pages; at the start, go to the background instead of closing (reopens instantly).
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView wv = getBridge().getWebView();
                if (wv.canGoBack()) wv.goBack();
                else moveTaskToBack(true);
            }
        });
    }

    /** All the hive page may ask of the app: match the system bars to its theme, or show the address screen again. */
    private class HiveAndroid {

        @JavascriptInterface
        public void setThemeColor(final String hex, final boolean light) {
            runOnUiThread(() -> {
                int c;
                try {
                    c = Color.parseColor(hex);
                } catch (IllegalArgumentException e) {
                    return;
                }
                Window w = getWindow();
                // the bar colour itself (Android 14 and older; newer ones draw the page's background under the bars)
                w.setStatusBarColor(c);
                w.setNavigationBarColor(c);
                w.getDecorView().setBackgroundColor(c);
                WebView wv = getBridge().getWebView();
                wv.setBackgroundColor(c);
                WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(w, w.getDecorView());
                bars.setAppearanceLightStatusBars(light);
                bars.setAppearanceLightNavigationBars(light);
            });
        }

        @JavascriptInterface
        public void openSetup() {
            runOnUiThread(() -> getBridge().getWebView().loadUrl(getBridge().getLocalUrl() + "/index.html?setup"));
        }
    }
}
