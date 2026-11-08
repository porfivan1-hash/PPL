в config.js стоят заглушки PUT_YOUR_CLIENT_ID_HERE. Для входа через Google нужен свой Client ID, и получить его можно бесплатно, примерно за 5 минут.

Откройте console.cloud.google.com, войдите в аккаунт и создайте проект (например, «MC Launcher»).
Зайдите в APIs & Services → OAuth consent screen (в новом интерфейсе это Google Auth platform). Укажите название приложения и свою почту, тип аудитории выберите External.
В разделе Audience (или Test users) добавьте свою почту и почту друга. Пока приложение в режиме Testing, войти смогут только они.
Откройте Credentials → Create credentials → OAuth client ID (в новом интерфейсе Clients → Create client). Тип приложения выберите Desktop app и нажмите Create.
Скопируйте Client ID и Client secret в config.js:
js
module.exports = {
  GOOGLE_CLIENT_ID: "123456-abc.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "GOCSPX-...",
}; 
надо скачать Electron или не чего не получится напишите npm.cmd install затем ждите когда собирётся напишите npm.cmd start 
затем радуетесь :D 
(у меня не получилось зделать exe файл)
