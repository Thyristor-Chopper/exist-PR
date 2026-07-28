package co.sofie.exist;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** 웹 → 네이티브: 통화 활성 여부 전달 (통화 중 홈 이동 시 화면째 PiP) */
@CapacitorPlugin(name = "CallPip")
public class CallPipPlugin extends Plugin {
    @PluginMethod
    public void setCallActive(PluginCall call) {
        MainActivity.callActive = Boolean.TRUE.equals(call.getBoolean("active", false));
        call.resolve();
    }
}
