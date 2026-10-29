<?php
/**
 * «Декларации ДТ» — «Путь для первоначальной установки» локального приложения.
 *
 * Запоминает владельца — администратора, который устанавливает программу: дальше
 * пользуется ею только он и те, кому он выдаст доступ. Создаёт таблицы программы
 * в базе портала и сообщает порталу installFinish — без этого пункта в меню не будет.
 */

define('NO_KEEP_STATISTIC', true);
define('NO_AGENT_CHECK', true);
define('NO_AGENT_STATISTIC', true);

require $_SERVER['DOCUMENT_ROOT'] . '/bitrix/modules/main/include/prolog_before.php';
require __DIR__ . '/lib.php';

use Gross\Declarations\Access;
use Gross\Declarations\Db;
use Gross\Declarations\Users;
use function Gross\Declarations\e;
use function Gross\Declarations\url;

$user = Access::current();
$ready = false;
$state = '';
try
{
	if ($user === null)
	{
		$state = 'Сессия портала не найдена — войдите на портал и установите приложение заново.';
	}
	elseif (!$user['admin'])
	{
		$state = 'Устанавливает приложение администратор портала.';
	}
	else
	{
		Db::ensure();
		if (Access::claim($user))
		{
			$state = 'Владелец программы — вы, ' . $user['name'] . '. Доступ сотрудникам выдаётся во вкладке «Доступ».';
		}
		else
		{
			$owner = Users::describe([Access::ownerId()])[0] ?? null;
			$state = 'Владелец программы уже назначен — ' . ($owner['name'] ?? '#' . Access::ownerId())
				. '. Доступ выдаёт он во вкладке «Доступ».';
		}
		$ready = true;
	}
}
catch (\Throwable $e)
{
	error_log('gross.declarations install: ' . $e);
	$state = 'Установка не завершена: ' . $e->getMessage();
}

header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');
?>
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Установка «Деклараций ДТ»</title>
<link rel="stylesheet" href="<?= e(url('style.css')) ?>">
</head>
<body>
<div class="login-view">
  <div class="login-card">
    <h1>Декларации ДТ</h1>
    <p class="sub" id="dt-state"><?= $ready ? 'Устанавливаем…' : e($state) ?></p>
    <?php if ($ready): ?>
    <p class="sub"><?= e($state) ?></p>
    <p class="sub">Дальше: откройте «Декларации ДТ» в меню слева → вкладка «Проверка».</p>
    <?php endif; ?>
  </div>
</div>
<?php if ($ready): ?>
<script src="//api.bitrix24.com/api/v1/"></script>
<script>
  (function () {
    var state = document.getElementById('dt-state');
    if (typeof BX24 === 'undefined') {
      // Файл открыли напрямую, а не из портала: сообщать порталу нечего.
      state.textContent = 'Владелец записан. Эту страницу открывает Битрикс24 при установке приложения.';
      return;
    }
    BX24.init(function () {
      BX24.installFinish();
      state.textContent = 'Декларации ДТ установлены. Пункт появится в меню слева.';
    });
  })();
</script>
<?php endif; ?>
</body>
</html>
