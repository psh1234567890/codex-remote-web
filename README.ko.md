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
- Codex 데스크톱 앱을 참고한 다크 UI (자체 구현, 공식 UI 자산 미포함)

### 디자인과 글꼴

색상, 프로젝트 사이드바, 채팅 말풍선, 입력창, 작업 패널을
Codex 데스크톱의 시각적 구성에 가깝게 맞췄습니다.
글꼴은 설치된 경우 `OpenAI Sans`를 우선 사용하고, 없으면
`Segoe UI Variable Text`, `Segoe UI`, `맑은 고딕` 순서로 대체합니다.
OpenAI의 전용 폰트 파일이나 로고 자산을 저장소에 포함하지 않으며,
공식 앱과 픽셀 단위의 일치를 보장하지 않습니다.

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
**아이패드 Safari에서는 Tailscale Serve(비공개 HTTPS)**를 사용합니다.
Tailscale Funnel(인터넷 전체에 공개)과 다르며, 같은 Tailnet에 로그인한
기기만 접속할 수 있습니다. PC와 아이패드에 Tailscale을 설치하고
같은 계정/Tailnet에 로그인한 뒤, PC에서 실행합니다.

```powershell
# 필요하면 허용할 프로젝트 경로를 지정하세요.
.\scripts\start-tailnet.cmd -Workspaces "C:\projects\my-app"
```

Windows에서 PowerShell 스크립트 실행이 차단될 수 있으므로
`.cmd` 실행 파일을 제공합니다. 이 파일은 **해당 실행 프로세스에서만**
PowerShell 실행 정책을 우회하며 시스템 전체 정책을 변경하지 않습니다.
자주 쓰는 작업 폴더는 Git에서 제외되는
`.local/tailnet-workspaces.txt`에 한 줄씩 저장할 수 있습니다.
이 파일이 있으면 다음부터 `.\scripts\start-tailnet.cmd`만 실행해도
동일한 작업 폴더를 사용할 수 있습니다.

기본적으로 HTTPS 포트 8443을 사용하고, 기존 443 포트 설정을 변경하지
않습니다. 출력된 `https://<PC의 Tailscale DNS 이름>:8443/` 주소를
아이패드 Safari에 입력하세요. 로그인에는 PC의
`.local/access-token` 파일에 있는 접근 토큰이 별도로 필요합니다.
토큰을 링크, 채팅 또는 GitHub에 붙여넣지 마세요.
PC를 재시작했다면 서버를 다시 실행해야 합니다.

이 방식은 Node 서버를 `127.0.0.1`에만 바인딩하며 Tailscale Serve가
HTTPS를 제공합니다. PC가 켜져 있고 Codex Remote Web이 실행 중이어야
아이패드에서도 접속할 수 있습니다. Tailscale의 기기 접근 권한(ACL)도
본인 기기로 제한하세요. 라우터 포트 포워딩이나 공개 인터넷 터널에
Codex Remote Web을 직접 연결하지 마세요.

## 현재 제한

- 공식 Codex Remote 모바일 기능과 동일하지 않습니다.
- Codex Desktop의 모든 대화가 보인다고 보장할 수 없습니다.
- 최근 대화 기록은 최대 12턴을 불러옵니다.
- 초기 MVP로, 독립적인 보안 감사를 받지 않았습니다.
- 공개 호스팅·다중 사용자 운영을 지원하지 않습니다.

자세한 기술 구조와 보안 설명은 [영문 README](README.md)와 [SECURITY.md](SECURITY.md)를 참고하세요.

**MIT License · Contributions welcome**
