@echo off
echo ========================================
echo   NCSE 知识图谱 Dashboard
echo ========================================
echo.
cd C:\Users\Feiqi\.claude\plugins\cache\understand-anything\understand-anything\2.7.5\packages\dashboard
set GRAPH_DIR=D:\Feiqi\桌面\NCSE-Practice-System
echo Starting dashboard...
echo.
npx vite --host 127.0.0.1
pause
