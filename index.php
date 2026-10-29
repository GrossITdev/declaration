<?php
/**
 * «Декларации ДТ» — «Путь вашего обработчика» локального приложения.
 *
 * Без ?action= — страница программы, с ?action= — JSON для неё (см. Api в lib.php).
 * Пускает владельца (того, кто установил программу) и сотрудников из вкладки «Доступ».
 */

define('NO_KEEP_STATISTIC', true);
define('NO_AGENT_CHECK', true);
define('NO_AGENT_STATISTIC', true);

require $_SERVER['DOCUMENT_ROOT'] . '/bitrix/modules/main/include/prolog_before.php';
require __DIR__ . '/lib.php';

use Gross\Declarations\Access;
use Gross\Declarations\Api;
use Gross\Declarations\Catalog;
use Gross\Declarations\Db;
use Gross\Declarations\Lists;
use Gross\Declarations\Settings;
use function Gross\Declarations\e;
use function Gross\Declarations\js;
use function Gross\Declarations\url;

$user = Access::current();

if (isset($_GET['action']))
{
	Api::handle($user);
	die();
}

if ($user === null)
{
	LocalRedirect('/auth/?backurl=' . urlencode((string)$_SERVER['REQUEST_URI']));
}

// Владельца ещё нет (или он уволен) — им становится администратор, открывший программу.
Access::claim($user);
$owner = Access::isOwner($user);
$canUse = Access::canUse($user);
$problem = '';
if ($canUse)
{
	try
	{
		Db::ensure();
	}
	catch (\Throwable $e)
	{
		error_log('gross.declarations: ' . $e);
		$problem = 'Не удалось подготовить таблицы программы в базе портала' . ($owner ? ': ' . $e->getMessage() : '');
	}
}

$boot = [
	'api' => url('index.php'),
	'sessid' => bitrix_sessid(),
	'user' => ['id' => $user['id'], 'name' => $user['name'], 'owner' => $owner, 'canUse' => $canUse],
	'minQuery' => Catalog::MIN_QUERY,
	// Значения списков «Резерв (где растоможили)» и «Орган въезда/выезда» — из полей смарт-процесса.
	'lists' => $canUse && $problem === '' ? Lists::boot(Settings::get()) : ['reserve' => ['options' => []], 'organ' => ['options' => []]],
];

header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');
?>
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Декларации ДТ</title>
<link rel="stylesheet" href="<?= e(url('style.css')) ?>">
</head>
<body>

<?php if (!$canUse || $problem !== ''): ?>
<div class="login-view" id="no-access">
  <div class="login-card">
    <h1>Декларации ДТ</h1>
    <?php if ($problem !== ''): ?>
    <p class="sub"><?= e($problem) ?></p>
    <?php else: ?>
    <p class="sub">Программой пользуются сотрудники, которым владелец программы выдал доступ.
      Обратитесь к тому, кто установил её на портал, — он добавит вас во вкладке «Доступ».</p>
    <?php endif; ?>
  </div>
</div>
<?php else: ?>
<div id="app" class="app-shell hidden">
  <aside class="sidebar">
    <div class="sidebar-brand"><strong>Декларации ДТ</strong><span>Себестоимость техники по ДТ</span></div>
    <nav class="nav">
      <button class="nav-item active" type="button" data-tab="decls">Декларации</button>
      <?php if ($owner): ?>
      <button class="nav-item owner-only" type="button" data-tab="access">Доступ</button>
      <button class="nav-item owner-only" type="button" data-tab="log">Журнал действий</button>
      <button class="nav-item owner-only" type="button" data-tab="check">Проверка</button>
      <?php endif; ?>
    </nav>
    <div class="sidebar-footer">
      <strong id="user-name"><?= e($user['name']) ?></strong>
      <span id="user-role"><?= $owner ? 'Владелец программы' : 'Сотрудник' ?></span>
    </div>
  </aside>

  <main class="main">
    <!-- ДЕКЛАРАЦИИ -->
    <section id="tab-decls">
      <div class="page-head"><div><h2>Декларации</h2>
        <p class="hint">Сначала создайте декларацию: ДТ, курс и проценты. Потом заполните в ней строки — VIN и суммы;
          стоимость в рублях, утиль сбор с НДС и итоги посчитаются сами. Готовые декларации — кнопкой «Отправить»:
          после отправки декларация убирается из списка.</p></div></div>

      <div class="card composer" id="entry-form">
        <div class="composer-head">
          <div><h3>Новая декларация</h3>
            <p class="desc">Наберите номер ДТ: уже существующую можно выбрать из списка — она откроется со всеми строками для правки.
              Нет в списке — создастся новая. Курс и проценты общие для всей декларации, строки с VIN и суммами заполняются уже в ней.
              Или «Загрузить XML» файла ДТ: декларация создастся сама — строка на каждый VIN, курс, орган въезда/выезда, резерв,
              сборы, пошлина и НДС (поровну на все VIN).</p></div>
          <div class="composer-tools">
            <button class="btn ghost small" type="button" id="xml-btn" title="Только XML-файл декларации на товары (.xml)">Загрузить XML</button>
            <input type="file" id="xml-file" accept=".xml,text/xml,application/xml" hidden>
            <button class="btn ghost small" type="button" id="form-clear">Очистить</button>
          </div>
        </div>
        <div class="composer-row">
          <div class="table-wrap entry-wrap" id="form-table" role="region" aria-label="Новая декларация"></div>
          <button class="btn" id="add-btn" type="button">Загрузить данные</button>
        </div>
        <p class="status composer-status" id="form-status" role="status"></p>
      </div>

      <div class="card queue">
        <div class="queue-head">
          <div><h3>Декларации <span class="queue-count" id="decl-count">0</span></h3>
            <p class="desc" id="decl-desc"></p></div>
          <div class="queue-tools">
            <input class="search-input" id="decl-search" type="search" autocomplete="off"
                   placeholder="Найти по ДТ, VIN или контракту" aria-label="Поиск деклараций">
            <button class="btn ghost small" type="button" id="expand-all">Развернуть все</button>
            <button class="btn ghost small" type="button" id="collapse-all">Свернуть все</button>
          </div>
        </div>
        <div class="decl-list" id="decl-list"><div class="decl-empty">Загрузка деклараций…</div></div>
        <div class="launch-row queue-actions">
          <button class="btn big" id="send-btn" type="button" disabled>📤 Отправить</button>
          <span class="status" id="send-status" role="status"></span>
          <span class="status save-status" id="save-status" role="status"></span>
        </div>
      </div>
    </section>

    <?php if ($owner): ?>
    <!-- ДОСТУП -->
    <section id="tab-access" class="hidden owner-only">
      <div class="page-head"><div><h2>Доступ</h2>
        <p class="hint">Программой пользуется только тот, кто её установил, и сотрудники, которым он выдал доступ здесь.
          Администраторы портала доступа автоматически не получают. Изменения действуют сразу.</p></div></div>
      <div class="card"><h3>Сотрудники с доступом</h3>
        <p class="desc">Нажмите на сотрудника, чтобы снять доступ. У владельца доступ есть всегда.</p>
        <div class="picker-head"><div class="picker-count">Выдано <b id="access-count">0</b></div></div>
        <div class="chips" id="access-chips">Загрузка…</div>
      </div>
      <div class="card"><h3>Выдать доступ</h3>
        <p class="desc">Список сотрудников — из портала. Нажмите на сотрудника, чтобы выдать или снять доступ.</p>
        <div class="picker-head">
          <div class="field"><input id="user-search" placeholder="Поиск по фамилии, имени, должности, e-mail" autocomplete="off"></div>
        </div>
        <div class="chips" id="user-chips">Загрузка…</div>
      </div>
    </section>

    <!-- ЖУРНАЛ ДЕЙСТВИЙ -->
    <section id="tab-log" class="hidden owner-only">
      <div class="page-head">
        <div><h2>Журнал действий</h2>
          <p class="hint">Каждое действие в программе: кто, когда и что сделал — открыл, ввёл, изменил,
            скопировал, удалил, отправил. Для изменений видно, что было и что стало. Записи не редактируются.</p></div>
        <div class="actions" style="margin:0">
          <button class="btn ghost" type="button" id="log-refresh">Обновить</button>
          <button class="btn ghost" type="button" id="log-export">Скачать CSV</button>
        </div>
      </div>
      <div class="card">
        <div class="picker-head log-filters">
          <div class="field"><input id="log-search" type="search" autocomplete="off" placeholder="Поиск: ДТ, VIN, действие, значение" aria-label="Поиск в журнале"></div>
          <div class="field"><select id="log-user" aria-label="Сотрудник"><option value="">Все сотрудники</option></select></div>
          <div class="field"><select id="log-cat" aria-label="Вид действия"><option value="">Все действия</option></select></div>
          <div class="picker-count">Записей <b id="log-count">0</b></div>
        </div>
        <div class="table-wrap" tabindex="0" role="region" aria-label="Журнал действий">
          <table class="table log-table">
            <colgroup><col style="width:150px"><col style="width:170px"><col><col style="width:220px"><col style="width:260px"></colgroup>
            <thead><tr><th scope="col">Время</th><th scope="col">Сотрудник</th><th scope="col">Действие</th><th scope="col">ДТ · VIN</th><th scope="col">Было → стало</th></tr></thead>
            <tbody id="log-rows"><tr class="queue-empty"><td colspan="5">Загрузка…</td></tr></tbody>
          </table>
        </div>
        <div class="actions" style="margin-top:0"><button class="btn ghost small" type="button" id="log-more" hidden>Показать ещё</button></div>
      </div>
    </section>

    <!-- ПРОВЕРКА -->
    <section id="tab-check" class="hidden owner-only">
      <div class="page-head">
        <div><h2>Проверка</h2>
          <p class="hint">Что программа видит на портале: модули, таблицы в базе, владельца,
            каталоги товаров и поля, где лежат VIN и модификация, список «Резерв» и шаблон бизнес-процесса.</p></div>
        <div class="actions" style="margin:0"><button class="btn ghost" type="button" id="check-run">Проверить заново</button></div>
      </div>
      <div id="check-result">Загрузка…</div>
      <div class="card"><h3>Пробный поиск по VIN</h3>
        <p class="desc">Тот же поиск, что в поле VIN: по всем товарам каталога — VIN, название, модель, артикул.</p>
        <div class="picker-head">
          <div class="field"><input id="probe-query" placeholder="цифры VIN или название товара" autocomplete="off"></div>
          <button class="btn ghost" type="button" id="probe-run">Найти</button>
        </div>
        <div id="probe-result"></div>
      </div>
      <div class="card"><h3>Настройки поиска</h3>
        <p class="desc">Пустое поле — подбирается само. Заполняйте, только если «Проверка» показала не те каталоги или поля.</p>
        <div class="grid">
          <div class="field"><label for="set-iblocks">Инфоблоки каталога (ID через запятую)</label>
            <input id="set-iblocks" autocomplete="off" placeholder="пусто — все каталоги товаров">
            <small id="set-iblocks-auto"></small></div>
          <div class="field"><label for="set-vin">Поля VIN</label>
            <input id="set-vin" autocomplete="off" placeholder="пусто — авто, например PROPERTY_123">
            <small>NAME, CODE, XML_ID или PROPERTY_&lt;ID&gt; через запятую.</small></div>
          <div class="field"><label for="set-model">Поля модели</label>
            <input id="set-model" autocomplete="off" placeholder="пусто — авто">
            <small>По ним тоже ищется товар; модель видна в подсказке.</small></div>
          <div class="field"><label for="set-mod">Свойство «Модификация» (код)</label>
            <input id="set-mod" autocomplete="off" placeholder="MODIFIKATSIYA">
            <small>Отсюда берётся «Марка модель» строки. Пусто — MODIFIKATSIYA.</small></div>
          <div class="field"><label for="set-decl">Свойство «Декларация» (код)</label>
            <input id="set-decl" autocomplete="off" placeholder="DECLARACIA">
            <small>Заполнено у товара — его VIN уже был в декларации, строку с ним не отправить. Пусто — DECLARACIA.</small></div>
        </div>
        <div class="actions">
          <button class="btn" type="button" id="settings-save">Сохранить</button>
          <button class="btn ghost" type="button" id="settings-reset">Вернуть автоподбор</button>
        </div>
      </div>
      <div class="card"><h3>Отправка в бизнес-процесс</h3>
        <p class="desc">«Отправить» запускает этот шаблон БП по одному разу на каждую строку декларации и передаёт ему
          значения строки. Карточки программа не создаёт — это делает сам БП, как в «Перегоне». Шаблон — в смарт-процессе,
          где лежит поле «Резерв». В шаблоне нужны параметры из таблицы ниже, с такими же кодами.</p>
        <div class="grid">
          <div class="field"><label for="set-template">ID шаблона БП</label>
            <input id="set-template" autocomplete="off" inputmode="numeric" placeholder="число, например 912">
            <small>Номер из адреса шаблона в дизайнере бизнес-процессов.</small></div>
          <div class="field"><label for="set-reserve">Поле «Резерв (где растоможили)»</label>
            <input id="set-reserve" autocomplete="off" placeholder="UF_CRM_14_1793082775">
            <small>Поле-список смарт-процесса: его значения — в выпадающем списке колонки, в БП уходит ID значения.</small></div>
          <div class="field"><label for="set-organ">Поле «Орган въезда/выезда»</label>
            <input id="set-organ" autocomplete="off" placeholder="UF_CRM_14_1793183988">
            <small>Тоже поле-список (код UF_… или ID поля). Пусто — UF_CRM_14_1793183988.</small></div>
        </div>
        <div class="actions">
          <button class="btn" type="button" id="bp-save">Сохранить</button>
        </div>
        <div class="table-wrap" tabindex="0" role="region" aria-label="Параметры шаблона БП">
          <table class="table bp-table">
            <colgroup><col style="width:210px"><col><col style="width:200px"><col style="width:300px"></colgroup>
            <thead><tr><th scope="col">Код параметра</th><th scope="col">Название</th><th scope="col">Тип в шаблоне</th><th scope="col">Что передаётся</th></tr></thead>
            <tbody id="bp-params"><tr class="queue-empty"><td colspan="4">Загрузка…</td></tr></tbody>
          </table>
        </div>
      </div>
    </section>
    <?php endif; ?>
  </main>
</div>

<dialog id="app-dialog" class="app-dialog" aria-labelledby="dialog-title">
  <div class="dialog-head">
    <div><h3 id="dialog-title"></h3><p class="desc" id="dialog-desc"></p></div>
    <button class="icon-btn" type="button" id="dialog-close" aria-label="Закрыть">×</button>
  </div>
  <div id="dialog-body"></div>
  <p class="dialog-error" id="dialog-error" role="alert"></p>
  <div class="dialog-actions">
    <button class="btn ghost" type="button" id="dialog-cancel">Отмена</button>
    <button class="btn" type="button" id="dialog-ok">OK</button>
  </div>
</dialog>

<script>window.DT_APP = <?= js($boot) ?>;</script>
<script src="<?= e(url('app.js')) ?>"></script>
<?php endif; ?>
</body>
</html>
