# Бэкенд рейтинга и матчей HOI4 — «РЫЖИЙ ТИГР»

Node.js 18+ · Express · SQLite · вход через Discord · рейтинг Elo (старт 1000, K=32).

## Запуск
1. Discord Developer Portal → New Application → OAuth2:
   добавьте Redirect URI (например `http://localhost:3000/auth/discord/callback`),
   скопируйте Client ID и Client Secret.
2. `cp .env.example .env` и заполните значения (`ADMIN_IDS` — ваши Discord ID, включите в Discord режим разработчика, чтобы скопировать ID).
3. `npm install && npm start`
4. `npm test` — проверка формулы рейтинга.

Вход: открыть `/auth/discord`. Кука `token` httpOnly, живёт 30 дней.

## API
| Метод | Путь | Кто | Что делает |
|---|---|---|---|
| GET | /auth/discord | все | вход через Discord |
| POST | /auth/logout | все | выход |
| GET | /api/me | вошедший | профиль и рейтинг |
| GET | /api/matches?status=open | все | список матчей (open, in_progress, finished, cancelled) |
| GET | /api/matches/:id | все | матч с игроками |
| POST | /api/matches | вошедший | создать `{title, team_size, scheduled_at?}` |
| POST | /api/matches/:id/join | вошедший | занять место `{side:"A"\|"B", country:"GER"?}` |
| POST | /api/matches/:id/leave | вошедший | выйти (пока набор открыт) |
| POST | /api/matches/:id/start | организатор/админ | начать матч |
| POST | /api/matches/:id/result | организатор/админ | внести победителя `{winner:"A"\|"B"}`, пересчитать рейтинг |
| POST | /api/matches/:id/cancel | организатор/админ | отменить |
| GET | /api/leaderboard | все | таблица лидеров |
| GET | /api/players/:id | все | профиль и история матчей |

## Как считается рейтинг
Берётся средний рейтинг каждой стороны, по нему вычисляется ожидаемый результат Elo.
Все игроки победившей стороны получают одинаковую прибавку, проигравшей — такую же потерю (сумма нулевая).
Рейтинг до матча и изменение сохраняются в `match_players`.

## Что не входит (можно добавить следующим шагом)
Группы, гайды, подтверждение результата обеими сторонами, rate limiting (например `express-rate-limit`),
бот для уведомлений в Discord, фронтенд. Для продакшена ставьте за nginx с HTTPS.
