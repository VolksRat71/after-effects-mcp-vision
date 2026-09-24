; Inno Setup script for AE MCP Vision.
;
; Installs per-user into %APPDATA%\Adobe\CEP\extensions - no admin rights, which
; is why PrivilegesRequired is lowest. Also sets PlayerDebugMode in HKCU, since
; unsigned extensions will not load without it.

#define AppName "AE MCP Vision"
#define BundleId "com.aemcpvision.bridge"
#ifndef AppVersion
  #define AppVersion "2.0.0"
#endif

[Setup]
AppId={{9E3A5C41-7B2D-4F88-9C13-AE0C0FE1B7A2}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=VolksRat71
AppSupportURL=https://github.com/VolksRat71/after-effects-mcp-vision
DefaultDirName={userappdata}\Adobe\CEP\extensions\{#BundleId}
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\..\dist
OutputBaseFilename=AE-MCP-Vision-{#AppVersion}-Windows
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName}
; After Effects reads the extensions folder at launch, so installing underneath
; a running instance yields a half-loaded state that looks like a broken install.
CloseApplications=no
AppMutex=

[Files]
Source: "..\..\cep\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; \
  Excludes: "*.log,.DS_Store,.debug"
; MIT requires the notice to travel with every copy, and an installed
; extension is a copy. This is a derivative of Dakkshin/after-effects-mcp.
Source: "..\..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
; Docs served as MCP resources; they live outside cep/, so ship them too.
Source: "..\..\docs\*.md"; DestDir: "{app}\docs"; Flags: ignoreversion

[Registry]
; Unsigned extensions require PlayerDebugMode, set per CSXS major version.
Root: HKCU; Subkey: "Software\Adobe\CSXS.10"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: createvalueifdoesntexist uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.11"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: createvalueifdoesntexist uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.12"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: createvalueifdoesntexist uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.13"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: createvalueifdoesntexist uninsdeletevalue

[Messages]
FinishedLabel=Installed.%n%nNext:%n1. Open After Effects.%n2. The MCP server starts automatically.%n3. Open Window > Extensions > AE MCP Vision for your connection settings.%n%nThe panel shows ready-to-paste configuration for Claude Desktop, Claude Code and Codex.

[Code]
function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
begin
  Result := True;
  // Refuse to install while After Effects is running - see CloseApplications above.
  if Exec('cmd.exe', '/C tasklist /FI "IMAGENAME eq AfterFX.exe" | find /I "AfterFX.exe"',
          '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    if ResultCode = 0 then
    begin
      // SuppressibleMsgBox, not MsgBox: /SUPPRESSMSGBOXES only answers
      // suppressible boxes. A plain MsgBox made a silent install with AE open
      // wait forever on a dialog no one could see (found over SSH on Windows).
      SuppressibleMsgBox('Please quit After Effects first, then run this installer again.'#13#10#13#10 +
             'After Effects loads extensions when it starts, so it needs to be closed during installation.',
             mbError, MB_OK, IDOK);
      Result := False;
    end;
  end;
end;
