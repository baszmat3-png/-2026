# مصاريفي — Masareefi 💰

تطبيق احترافي لإدارة المصاريف الشخصية بالدينار العراقي: ويب + أندرويد، مع حسابات مستخدمين وقاعدة بيانات PostgreSQL. كل مستخدم له بياناته الخاصة.

## المزايا
- إنشاء حساب وتسجيل دخول برقم الهاتف أو البريد الإلكتروني (كلمات المرور مشفّرة بـ scrypt)
- مزامنة تلقائية مع الخادم + يعمل بدون إنترنت ويزامن عند عودة الاتصال
- المحافظ، المعاملات (وارد / صادر / تحويل)، الأقسام، الأولوية، الميزانية الشهرية
- الإحصائيات: رسم دائري للأقسام، حسب الأولوية، آخر 6 أشهر
- الديون والأقساط، الأهداف المالية، الوضع الليلي، الرقم السري، إخفاء الأرصدة
- **تصدير Excel** (6 أوراق: المعاملات بالتفصيل مع الرصيد المتبقي، الملخص، الأقسام، المحافظ، الديون، الأهداف)
- **تصدير PDF** (تقرير مفصل جاهز للطباعة/المشاركة)
- تعديل الحساب، تغيير كلمة المرور، حذف الحساب (مطلوب لـ Google Play)، صفحة سياسة الخصوصية `/privacy`

## هيكل المشروع
```
server.js              الخادم (Node.js بدون إطار عمل) + API
lib/xlsx.js            مولّد ملفات Excel
public/index.html      التطبيق (واجهة المستخدم)
public/report-core.js  منطق التقارير (مشترك بين الخادم والتطبيق)
public/privacy.html    سياسة الخصوصية
android/               تطبيق الأندرويد (WebView)
.github/workflows/     بناء APK و AAB تلقائياً
render.yaml            النشر على Render (خادم + قاعدة بيانات)
```

## النشر على Render
1. Render ← **New** ← **Blueprint** ← اختر هذا المستودع.
2. سيُنشئ تلقائياً الخادم `masareefi` وقاعدة البيانات `masareefi-db` ويضبط `DATABASE_URL` و `JWT_SECRET`.
3. الجداول تُنشأ تلقائياً عند أول تشغيل.

## تطبيق الأندرويد
- يُبنى تلقائياً عبر GitHub Actions عند كل تعديل في مجلد `android/`، وتجد الملفات في **Releases**:
  - `Masareefi.apk` للتثبيت المباشر
  - `Masareefi.aab` للرفع على Google Play
- رابط الخادم الافتراضي: `https://masareefi.onrender.com`.
  إذا أعطاك Render رابطاً مختلفاً: Settings ← Secrets and variables ← Actions ← Variables ← أضف `APP_URL`، ثم Actions ← Build Android APK ← Run workflow.
- أسرار التوقيع (Secrets): `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
  احتفظ بنسخة من ملف المفتاح — بدونه لا يمكن تحديث التطبيق على Google Play.

## التشغيل محلياً
```bash
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/masareefi JWT_SECRET=change-me npm start
# بدون DATABASE_URL يستخدم ملف data/db.json للتجربة فقط
```

## API
| الطريقة | المسار | الوصف |
|---|---|---|
| POST | `/api/auth/register` | إنشاء حساب `{name, identifier, password}` |
| POST | `/api/auth/login` | تسجيل الدخول `{identifier, password}` |
| GET / PATCH / DELETE | `/api/me` | معلومات الحساب / تعديل الاسم / حذف الحساب |
| POST | `/api/me/password` | تغيير كلمة المرور |
| GET / PUT | `/api/data` | بيانات المستخدم (مع رقم مراجعة لمنع التعارض) |
| POST | `/api/export/link` | رابط تنزيل Excel موقّع صالح 10 دقائق |
