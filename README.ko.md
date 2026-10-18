# Codex Remote Web

**내 PC의 Codex를 웹에서 확인하고 지시하는 개인용 오픈소스 대시보드.**

> 비공식 커뮤니티 프로젝트이며 OpenAI 공식 제품이 아닙니다.
> 실행 중인 Codex 데스크톱 앱의 창을 직접 조종하는 기능이 아닙니다.
> 별도의 Codex `app-server` 프로세스를 실행하고, 호환되는 로컬 저장 대화를 불러옵니다.

## 지금 되는 것

- 허용된 프로젝트의 Codex 대화 목록 및 최근 기록 확인
- 새 작업 생성, 추가 지시 전송, 진행 상황 실시간 확인
- 작업 중지, 명령 실행·파일 변경 요청의 1회 승인/거절
- 접근 토큰 인증 및 작업 폴더 허용 목록
- PC 로컬 실행, 반응형 웹 UI

## 실행 방법 (Windows)

Node.js 22 이상과 Git, npm이 필요합니다.

```powershell
git clone https://github.com/psh1234567890/codex-remote-web.git
cd codex-remote-web
npm.cmd ci
npm.cmd exec -- codex login
```

Codex에 로그인한 다음, 접근할 작업 폴더를 지정해 실행합니다.

```powershell
$env:CODEX_WORKSPACES = "C:\\projects\\my-app"
npm.cmd start
```

브라우저에서 <http://127.0.0.1:4765>에 접속하고, 별도 터미널에서 다음 명령으로 확인한 토큰을 로그인 화면에 입력합니다.

```powershell
Get-Content .local/access-token
```

토큰 파일은 Git에 올라가지 않도록 제외되어 있습니다. 다른 사람에게 공유하지 마세요.

## 다른 기기에서 접속하기

기본적으로 **같은 PC의 브라우저에서만** 접속할 수 있습니다.
다른 기기에서 접속하려면 개인용 HTTPS 네트워크와 접근 제어가 필요합니다.
라우터 포트 포워딩이나 공개 인터넷 터널에 그대로 연결하지 마세요.

## 현재 제한

- 공식 Codex Remote 모바일 기능과 동일하지 않습니다.
- Codex Desktop의 모든 대화가 보인다고 보장할 수 없습니다.
- 최근 대화 기록은 최대 12턴을 불러옵니다.
- 초기 MVP로, 독립적인 보안 감사를 받지 않았습니다.
- 공개 호스팅·다중 사용자 운영을 지원하지 않습니다.

자세한 기술 구조와 보안 설명은 [영문 README](README.md)와 [SECURITY.md](SECURITY.md)를 참고하세요.

**MIT License · Contributions welcome**
