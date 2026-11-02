; Windows 설치본(NSIS)이 지원 파일의 "연결 프로그램" 목록에 thuminal 을 올린다 (tauri.windows.conf.json installerHooks).
;
; Tauri 의 bundle.fileAssociations 는 Windows 에서 `.md` 같은 확장자의 기본 연결 값을 thuminal 로 덮어써 기본 앱을 빼앗는다.
; 그래서 Windows 는 그것을 쓰지 않고(tauri.windows.conf.json 에서 null), 확장자마다 OpenWithProgids 에 thuminal 을 더하기만 한다.
; 확장자 목록은 tauri.conf.json bundle.fileAssociations 와 같게 둔다. 맨 앞 BOM 은 NSIS 가 이 파일을 UTF-8 로 읽게 한다.

!define THUMINAL_PROGID "thuminal.file"

!macro THUMINAL_OPEN_WITH EXT
  WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${THUMINAL_PROGID}" ""
!macroend

!macro THUMINAL_OPEN_WITH_REMOVE EXT
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${THUMINAL_PROGID}"
!macroend

!macro THUMINAL_EXTS MACRO
  !insertmacro ${MACRO} "md"
  !insertmacro ${MACRO} "markdown"
  !insertmacro ${MACRO} "json"
  !insertmacro ${MACRO} "txt"
  !insertmacro ${MACRO} "yaml"
  !insertmacro ${MACRO} "yml"
  !insertmacro ${MACRO} "toml"
  !insertmacro ${MACRO} "log"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 파일을 넘겨받는 ProgID. 앱이 켜져 있으면 단일 인스턴스 플러그인이 켜진 앱에 넘긴다 (open_files.rs)
  WriteRegStr SHELL_CONTEXT "Software\Classes\${THUMINAL_PROGID}" "" "${PRODUCTNAME}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${THUMINAL_PROGID}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${THUMINAL_PROGID}\shell\open" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${THUMINAL_PROGID}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  !insertmacro THUMINAL_EXTS THUMINAL_OPEN_WITH
  ; 탐색기가 연결 목록을 다시 읽게 한다 (SHCNE_ASSOCCHANGED)
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro THUMINAL_EXTS THUMINAL_OPEN_WITH_REMOVE
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${THUMINAL_PROGID}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
