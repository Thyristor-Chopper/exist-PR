package co.sofie.exist;

import android.app.PictureInPictureParams;
import android.os.Build;
import android.os.Bundle;
import android.util.Rational;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /** 웹(MeetingView)이 CallPip 플러그인으로 세팅 — 통화 중일 때만 홈 이동 시 PiP 진입 */
    static volatile boolean callActive = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CallPipPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (callActive && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                enterPictureInPictureMode(
                        new PictureInPictureParams.Builder()
                                .setAspectRatio(new Rational(9, 16))
                                .build());
            } catch (Exception ignored) {
                // PiP 미지원 기기 — 조용히 무시
            }
        }
    }
}
