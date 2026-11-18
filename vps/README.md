# تشغيل Zone-BarMi على سيرفر ثابت (Vultr أو أي VPS)

نفس المشروع ونفس النفق ونفس اللوحة، بس يشتغل على سيرفر دائم بدل GitHub Actions.
اللوحة (GitHub Pages) تقرأ رابط النفق من `docs/current-stream.json` مثل قبل، والسيرفر هو اللي يحدّثه.

## قبل ما تبدأ
- سيرفر Ubuntu 22.04 أو 24.04 (يكفي 2 معالج و4GB رام وقرص 80GB فأكثر).
- مستودع GitHub الجديد فيه المشروع (ومفعّل GitHub Pages على مجلد `docs`).
- توكن GitHub: Settings ← Developer settings ← Fine-grained tokens ← على المستودع الجديد فقط ← Contents: Read and write.

## الخطوات
1. ادخل السيرفر (ssh) وحمّل مشروعك من المستودع الجديد:
   `git clone https://github.com/صاحبك/Zone-BarMi.git && cd Zone-BarMi`
2. شغّل التجهيز (أول مرة ينشئ ملف `.env` ويوقف):
   `sudo ./vps/setup.sh`
3. عبّي الأسرار: `nano .env`
   - نفس أسرار الأكشن القديمة (`API_KEY` و`TELEGRAM_BOT_TOKEN` ...).
   - `GH_REPO` (مثال `myname/Zone-BarMi`) و`GH_PUSH_TOKEN` و`PANEL_PAGE_URL`.
   - اختياري: `TG_API_ID` و`TG_API_HASH` للأجزاء حتى 2GB.
4. شغّل التجهيز مرة ثانية: `sudo ./vps/setup.sh` (ينشئ الخدمة ويشغّلها).
5. انتظر دقيقة. يوصلك إشعار "سيرفر Zone-BarMi شغّال" بالبوت، وتفتح اللوحة وتلقاها شغّالة (الشارة: "السيرفر شغّال").

## أوامر مفيدة
- الحالة: `systemctl status zone-barmi`
- السجل: `tail -f logs/run.log` و`logs/server.log`
- إعادة تشغيل: `sudo systemctl restart zone-barmi`
- تحديث المشروع: `git pull && sudo systemctl restart zone-barmi`

## ملاحظات
- لو النفق انقطع أو تغيّر رابطه، السيرفر يعيد تشغيله وينشر الرابط الجديد للوحة تلقائيًا ويرسل لك إشعار.
- ما عاد تحتاج ملفات `.github/workflows`. لا ترفعها على الحساب الجديد (أو احذفها)، عشان ما يشتغل عندك بث على Actions مرة ثانية.
- قسم التسجيل في اللوحة يشتغل على نفس السيرفر مباشرة (ما يحتاج أكشن مستقل ولا زر بوت).
- ملفات مؤقتة أقدم من يومين تتنظف تلقائيًا.
