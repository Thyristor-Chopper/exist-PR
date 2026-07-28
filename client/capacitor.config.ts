import type { CapacitorConfig } from '@capacitor/cli';

// exist 모바일 셸 — 웹뷰가 라이브를 그대로 로드하는 얇은 앱.
// 네이티브 가치: 안드로이드 화면째 PiP(통화 중 홈 이동 시), 추후 푸시.
const config: CapacitorConfig = {
  appId: 'co.sofie.exist',
  appName: 'exist',
  webDir: 'dist',
  server: {
    // 앱 스토어 배포 전 셸 모드 — 라이브를 직접 로드 (배포는 기존 웹 배포로 일원화)
    url: 'https://exist.sofie.co.kr',
    cleartext: false,
  },
};

export default config;
