@echo off
setlocal
set PATH=%PATH%;C:\Users\corentin.lefeuvre\Downloads\Logiciels\node-v24.14.1-win-x64\node-v24.14.1-win-x64

echo === Installation des dependances ===
call npm install
if errorlevel 1 ( echo ERREUR npm install & pause & exit /b 1 )

echo === Build de verification ===
call npm run build
if errorlevel 1 ( echo. & echo BUILD ECHOUE : rien n'est pousse. & pause & exit /b 1 )

echo === Build OK : envoi vers Git ===
git add .
git commit -m "Update"
git push
echo.
echo Deploiement envoye !
pause