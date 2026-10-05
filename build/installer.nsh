!macro customInstall
  WriteRegStr HKCU "Software\Classes\Directory\shell\ClaudeTerm.Claude" "" "Open Claude Code here"
  WriteRegStr HKCU "Software\Classes\Directory\shell\ClaudeTerm.Claude" "Icon" "$INSTDIR\ClaudeTerm.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\ClaudeTerm.Claude\command" "" '"$INSTDIR\ClaudeTerm.exe" --claude "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ClaudeTerm.Claude" "" "Open Claude Code here"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ClaudeTerm.Claude" "Icon" "$INSTDIR\ClaudeTerm.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ClaudeTerm.Claude\command" "" '"$INSTDIR\ClaudeTerm.exe" --claude "%V"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\ClaudeTerm.Claude"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\ClaudeTerm.Claude"
  ; Clean up ClaudeTerm.Shell keys from older installations
  DeleteRegKey HKCU "Software\Classes\Directory\shell\ClaudeTerm.Shell"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\ClaudeTerm.Shell"
  ${ifNot} ${isUpdated}
    nsExec::Exec 'cmd.exe /d /c claude mcp remove --scope user claudeterm'
    Pop $0
  ${endIf}
!macroend
