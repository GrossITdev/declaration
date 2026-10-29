<?php
/**
 * «Декларации ДТ» — вся серверная логика программы.
 *
 * Программа лежит на самом портале (/local/tools/declarations/) и работает через
 * его ядро — без вебхука и REST, как «Перегон техники». Кто открыл программу —
 * из сессии портала. Владелец, доступы и настройки — в настройках портала
 * (b_option, модуль gross.declarations). Декларации и журнал действий — в своих
 * таблицах базы портала (gross_dt_decl, gross_dt_log): они создаются сами при
 * установке или первом обращении.
 */

namespace Gross\Declarations;

use Bitrix\Crm\Service\Container;
use Bitrix\Iblock\PropertyTable;
use Bitrix\Iblock\SectionTable;
use Bitrix\Main\Application;
use Bitrix\Main\Config\Option;
use Bitrix\Main\Loader;
use Bitrix\Main\UserTable;

defined('B_PROLOG_INCLUDED') || exit;

// Предупреждение PHP посреди JSON сломало бы ответ: ошибки — только в журнал сервера.
ini_set('display_errors', '0');


// ---------- общее ----------

/** Текст в HTML без сюрпризов. */
function e(string $text): string
{
	return htmlspecialchars($text, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/** Данные для скрипта страницы: безопасно внутри <script>. */
function js($data): string
{
	return (string)json_encode($data, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
		| JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT);
}

/**
 * Адрес файла программы от корня сайта. Метка времени файла — чтобы после
 * замены файла браузер взял новый.
 */
function url(string $file): string
{
	$base = rtrim(str_replace('\\', '/', dirname((string)$_SERVER['SCRIPT_NAME'])), '/');
	$path = __DIR__ . '/' . $file;
	$version = substr($file, -4) !== '.php' && is_file($path) ? '?v=' . filemtime($path) : '';

	return $base . '/' . $file . $version;
}

/** Время для браузера: ISO 8601 в UTC. */
function now(): string
{
	return gmdate('Y-m-d\TH:i:s\Z');
}

/** Ошибка, которую пользователь видит как есть: в тексте нет ничего внутреннего. */
class AppError extends \RuntimeException
{
}

final class Text
{
	/** Значение из браузера — только скаляр: массив вместо строки дал бы «Array». */
	public static function scalar($value): string
	{
		return is_scalar($value) ? (string)$value : '';
	}

	/** Схлопывает пробелы, включая неразрывные, и обрезает края. */
	public static function clean(string $text): string
	{
		return trim((string)preg_replace('/[\s\x{00A0}\x{202F}]+/u', ' ', $text));
	}

	/** Строка из браузера не длиннее $max знаков. */
	public static function short($value, int $max): string
	{
		return mb_substr(trim(self::scalar($value)), 0, $max);
	}

	/**
	 * Текст значения свойства: строка, HTML-свойство {TEXT, TYPE} (бывает и
	 * сериализованным) или список значений — первое непустое.
	 */
	public static function value($value): string
	{
		if (is_string($value) && strncmp($value, 'a:', 2) === 0)
		{
			$data = @unserialize($value, ['allowed_classes' => false]);
			$value = is_array($data) ? $data : $value;
		}
		if (is_array($value))
		{
			if (array_key_exists('TEXT', $value))
			{
				return self::value($value['TEXT']);
			}
			foreach ($value as $item)
			{
				$text = self::value($item);
				if ($text !== '')
				{
					return $text;
				}
			}

			return '';
		}
		$text = (string)preg_replace('/<br\s*\/?>/i', ' ', self::scalar($value));

		return self::clean(html_entity_decode(strip_tags($text), ENT_QUOTES, 'UTF-8'));
	}

	/** Флаг: 1, "1", "Y", true — да. */
	public static function flag($value): bool
	{
		if (is_bool($value))
		{
			return $value;
		}

		return in_array(mb_strtolower(self::scalar($value)), ['1', 'y', 'yes', 'true', 'on'], true);
	}
}

final class Portal
{
	/** Модули портала, без которых шаг не сделать. */
	public static function need(string ...$modules): void
	{
		foreach ($modules as $module)
		{
			if (!Loader::includeModule($module))
			{
				throw new AppError('На портале не установлен модуль «' . $module . '»');
			}
		}
	}
}

/** Небольшие данные программы в настройках портала: переживают замену файлов. */
final class Store
{
	public const MODULE = 'gross.declarations';

	public static function get(string $name): array
	{
		$data = json_decode((string)Option::get(self::MODULE, $name, ''), true);

		return is_array($data) ? $data : [];
	}

	public static function set(string $name, array $data): void
	{
		$json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
		if ($json === false)
		{
			throw new AppError('Не удалось сохранить данные программы: ' . json_last_error_msg());
		}
		Option::set(self::MODULE, $name, $json);
	}
}


// ---------- настройки ----------

/**
 * Где искать товары и их VIN. Всё пустое — подбирается само: все каталоги товаров
 * портала (без инфоблоков торговых предложений), VIN — «Название» и строковые
 * свойства со словами VIN / серийный / заводской номер, марка — свойства «модель» / «марка».
 * «Марка модель» строки — свойство товара с кодом modification_code. Заполнено у товара свойство
 * declaration_code (DECLARACIA) — VIN уже был в декларации, новый элемент по нему не создаётся.
 * Куда уходит «Отправить» — шаблон БП bp_template_id; списки «Резерв» и «Орган въезда/выезда» —
 * поля reserve_field и organ_field (код UF_… или ID поля). Правится во вкладке «Проверка».
 */
final class Settings
{
	private const DEFAULTS = [
		'catalog_iblock_ids' => [],
		'vin_fields' => [],
		'model_fields' => [],
		'modification_code' => 'MODIFIKATSIYA',
		'declaration_code' => 'DECLARACIA',
		'bp_template_id' => 0,
		'reserve_field' => 'UF_CRM_14_1793082775',
		'organ_field' => 'UF_CRM_14_1793183988',
	];
	/** «Вернуть автоподбор» — про поиск: шаблон БП и поля-списки он не трогает. */
	private const KEEP_ON_RESET = ['bp_template_id', 'reserve_field', 'organ_field'];
	/** Поле-список: код UF_CRM_14_1793082775 или ID поля (число). */
	private const LIST_FIELD = '/^(UF_[A-Z0-9_]{1,47}|\d{1,9})$/';

	public static function get(): array
	{
		return self::normalize(array_merge(self::DEFAULTS, Store::get('settings')));
	}

	public static function save(array $input): array
	{
		$input = array_intersect_key($input, self::DEFAULTS);
		// Опечатка не должна молча превратиться в «по умолчанию»: говорим, что не так.
		$template = trim(Text::scalar($input['bp_template_id'] ?? ''));
		if ($template !== '' && !preg_match('/^\d{1,9}$/', $template))
		{
			throw new AppError('ID шаблона БП — число из адреса шаблона в дизайнере бизнес-процессов');
		}
		foreach (['reserve_field' => 'Резерв (где растоможили)', 'organ_field' => 'Орган въезда/выезда'] as $key => $label)
		{
			$field = strtoupper(trim(Text::scalar($input[$key] ?? '')));
			if ($field !== '' && !preg_match(self::LIST_FIELD, $field))
			{
				throw new AppError('Поле «' . $label . '» — код вида UF_CRM_14_1793082775 или ID поля (число)');
			}
		}
		foreach (['modification_code' => 'Модификация» — латиница, цифры и «_», например MODIFIKATSIYA',
			'declaration_code' => 'Декларация» — латиница, цифры и «_», например DECLARACIA'] as $key => $hint)
		{
			$code = strtoupper(trim(Text::scalar($input[$key] ?? '')));
			if ($code !== '' && !preg_match('/^[A-Z0-9_]{1,50}$/', $code))
			{
				throw new AppError('Код свойства «' . $hint);
			}
		}
		$s = self::normalize(array_merge(self::get(), $input));
		Store::set('settings', $s);

		return $s;
	}

	public static function reset(): array
	{
		Store::set('settings', array_intersect_key(self::get(), array_flip(self::KEEP_ON_RESET)));

		return self::get();
	}

	/** Список положительных ID из массива или строки «15, 22». */
	public static function ids($value): array
	{
		if (is_string($value))
		{
			$value = preg_split('/[\s,;]+/', $value);
		}
		$ids = [];
		foreach ((array)$value as $item)
		{
			$id = (int)Text::scalar($item);
			if ($id > 0)
			{
				$ids[$id] = $id;
			}
		}

		return array_values($ids);
	}

	/** Поля элемента: стандартные или PROPERTY_<номер>. Остальное — мусор, его не храним. */
	public static function fields($value): array
	{
		if (is_string($value))
		{
			$value = preg_split('/[\s,;]+/', $value);
		}
		$out = [];
		foreach ((array)$value as $field)
		{
			$field = strtoupper(trim(Text::scalar($field)));
			if (preg_match('/^(NAME|CODE|XML_ID|PROPERTY_\d+)$/', $field))
			{
				$out[$field] = $field;
			}
		}

		return array_values($out);
	}

	private static function normalize(array $s): array
	{
		$code = strtoupper(trim(Text::scalar($s['modification_code'])));
		$declaration = strtoupper(trim(Text::scalar($s['declaration_code'])));
		$field = strtoupper(trim(Text::scalar($s['reserve_field'])));
		$organ = strtoupper(trim(Text::scalar($s['organ_field'])));

		return [
			'catalog_iblock_ids' => self::ids($s['catalog_iblock_ids']),
			'vin_fields' => self::fields($s['vin_fields']),
			'model_fields' => self::fields($s['model_fields']),
			'modification_code' => preg_match('/^[A-Z0-9_]{1,50}$/', $code) ? $code : self::DEFAULTS['modification_code'],
			'declaration_code' => preg_match('/^[A-Z0-9_]{1,50}$/', $declaration) ? $declaration : self::DEFAULTS['declaration_code'],
			'bp_template_id' => max(0, (int)Text::scalar($s['bp_template_id'])),
			'reserve_field' => preg_match(self::LIST_FIELD, $field) ? $field : self::DEFAULTS['reserve_field'],
			'organ_field' => preg_match(self::LIST_FIELD, $organ) ? $organ : self::DEFAULTS['organ_field'],
		];
	}
}


// ---------- владелец и доступ ----------

/**
 * Пользуется программой только тот, кто её установил (владелец), и сотрудники,
 * которым он выдал доступ. Администраторы портала доступа сами по себе не получают.
 */
final class Access
{
	public static function current(): ?array
	{
		global $USER;
		if (!is_object($USER) || !$USER->IsAuthorized())
		{
			return null;
		}
		$name = Text::clean((string)$USER->GetFullName());

		return [
			'id' => (int)$USER->GetID(),
			'admin' => (bool)$USER->IsAdmin(),
			'name' => $name !== '' ? $name : (string)$USER->GetLogin(),
		];
	}

	public static function ownerId(): int
	{
		return (int)(Store::get('owner')['id'] ?? 0);
	}

	public static function isOwner(array $user): bool
	{
		return $user['id'] > 0 && $user['id'] === self::ownerId();
	}

	/**
	 * Администратор становится владельцем, если владельца ещё нет (установка)
	 * или прежний владелец уволен / удалён — иначе программой некому было бы управлять.
	 */
	public static function claim(array $user): bool
	{
		if (!$user['admin'])
		{
			return false;
		}
		$owner = self::ownerId();
		if ($owner === $user['id'])
		{
			return true;
		}
		if ($owner > 0)
		{
			$card = Users::describe([$owner])[0] ?? null;
			if ($card !== null && $card['active'])
			{
				return false;
			}
		}
		Store::set('owner', ['id' => $user['id'], 'name' => $user['name'], 'since' => now()]);

		return true;
	}

	public static function allowed(): array
	{
		return Settings::ids(Store::get('users'));
	}

	public static function canUse(array $user): bool
	{
		return self::isOwner($user) || in_array($user['id'], self::allowed(), true);
	}

	public static function grant(int $id): void
	{
		Store::set('users', array_values(array_unique(array_merge(self::allowed(), [$id]))));
	}

	public static function revoke(int $id): void
	{
		Store::set('users', array_values(array_diff(self::allowed(), [$id])));
	}
}

/** Сотрудники портала — для вкладки «Доступ». */
final class Users
{
	private const LIMIT = 50;

	public static function search(string $query): array
	{
		$filter = ['=ACTIVE' => 'Y', self::people()];
		foreach (preg_split('/\s+/u', Text::clean($query), -1, PREG_SPLIT_NO_EMPTY) as $word)
		{
			$filter[] = [
				'LOGIC' => 'OR',
				'%LAST_NAME' => $word,
				'%NAME' => $word,
				'%SECOND_NAME' => $word,
				'%WORK_POSITION' => $word,
				'%EMAIL' => $word,
				'%LOGIN' => $word,
			];
		}

		return self::load($filter, self::LIMIT);
	}

	/** Карточки по ID. Уволенный остаётся в списке доступа — его видно и можно убрать. */
	public static function describe(array $ids): array
	{
		$ids = Settings::ids($ids);
		$cards = $ids ? self::load(['@ID' => $ids], 0) : [];
		foreach (array_diff($ids, array_column($cards, 'id')) as $id)
		{
			$cards[] = ['id' => $id, 'name' => 'Пользователь #' . $id, 'position' => 'удалён с портала', 'active' => false];
		}

		return $cards;
	}

	private static function load(array $filter, int $limit): array
	{
		$query = [
			'select' => ['ID', 'LOGIN', 'EMAIL', 'NAME', 'LAST_NAME', 'SECOND_NAME', 'WORK_POSITION', 'ACTIVE'],
			'filter' => $filter,
			'order' => ['LAST_NAME' => 'ASC', 'NAME' => 'ASC', 'ID' => 'ASC'],
		];
		if ($limit > 0)
		{
			$query['limit'] = $limit;
		}
		$format = \CSite::GetNameFormat(false);
		$out = [];
		$rows = UserTable::getList($query);
		while ($row = $rows->fetch())
		{
			$name = Text::clean((string)\CUser::FormatName($format, $row, true, false));
			$out[] = [
				'id' => (int)$row['ID'],
				'name' => $name !== '' ? $name : '#' . $row['ID'],
				'position' => Text::clean((string)$row['WORK_POSITION']),
				'active' => Text::flag($row['ACTIVE']),
			];
		}

		return $out;
	}

	/** Живые люди: без ботов, почтовых и прочих служебных пользователей. */
	private static function people(): array
	{
		$external = method_exists(UserTable::class, 'getExternalUserTypes')
			? UserTable::getExternalUserTypes()
			: ['bot', 'email', 'imconnector', 'replica', 'controller', 'shop', 'sale', 'saleanonymous'];

		return ['LOGIC' => 'OR', '=EXTERNAL_AUTH_ID' => null, '!@EXTERNAL_AUTH_ID' => $external];
	}
}


// ---------- каталог товаров ----------

/** Поля элементов инфоблока, где имеет смысл искать и откуда брать текст. */
final class Fields
{
	public const BASE = ['NAME' => 'Название', 'CODE' => 'Символьный код', 'XML_ID' => 'Внешний код'];

	private static array $cache = [];

	/** Строковые свойства инфоблока: привязки, списки и файлы текста не несут. */
	public static function properties(int $iblockId): array
	{
		if (!isset(self::$cache[$iblockId]))
		{
			Portal::need('iblock');
			$out = [];
			$rows = PropertyTable::getList([
				'select' => ['ID', 'NAME', 'CODE', 'USER_TYPE'],
				'filter' => ['=IBLOCK_ID' => $iblockId, '=ACTIVE' => 'Y', '=PROPERTY_TYPE' => 'S'],
				'order' => ['SORT' => 'ASC', 'ID' => 'ASC'],
			]);
			while ($row = $rows->fetch())
			{
				if (in_array((string)$row['USER_TYPE'], ['', 'HTML'], true))
				{
					$out['PROPERTY_' . (int)$row['ID']] = [
						'field' => 'PROPERTY_' . (int)$row['ID'],
						'name' => Text::clean((string)$row['NAME']),
						'code' => (string)$row['CODE'],
					];
				}
			}
			self::$cache[$iblockId] = $out;
		}

		return self::$cache[$iblockId];
	}

	/** Свойства, у которых название или код подходят под шаблон. */
	public static function matching(int $iblockId, string $pattern): array
	{
		$out = [];
		foreach (self::properties($iblockId) as $property)
		{
			if (preg_match($pattern, $property['name'] . ' ' . $property['code']))
			{
				$out[] = $property['field'];
			}
		}

		return $out;
	}

	/** Поля из настроек, которые есть у этого инфоблока. */
	public static function own(int $iblockId, array $fields): array
	{
		$properties = self::properties($iblockId);

		return array_values(array_filter($fields, static function (string $field) use ($properties) {
			return isset(self::BASE[$field]) || isset($properties[$field]);
		}));
	}

	/** Понятное имя поля: «Название», «VIN [VIN]». */
	public static function title(int $iblockId, string $field): string
	{
		if (isset(self::BASE[$field]))
		{
			return self::BASE[$field];
		}
		$property = self::properties($iblockId)[$field] ?? null;
		if ($property === null)
		{
			return $field;
		}

		return $property['name'] . ($property['code'] !== '' ? ' [' . $property['code'] . ']' : '') . ' — ' . $field;
	}

	/** Значение поля из строки CIBlockElement::GetList: свойство приходит как PROPERTY_<ID>_VALUE. */
	public static function value(array $row, string $field): string
	{
		return Text::value($row[strpos($field, 'PROPERTY_') === 0 ? $field . '_VALUE' : $field] ?? '');
	}
}

/**
 * Подсказки в поле VIN — ВСЕ товары портала, не только техника: каждый каталог
 * товаров, все его папки. Ищется по VIN (и серийному номеру), названию, модели и артикулу.
 * У товара без VIN (навесное, запчасти) в ячейку встаёт его название.
 */
final class Catalog
{
	public const MIN_QUERY = 3;
	private const LIMIT = 20;
	private const VIN = '/vin|(^|[^\p{L}])вин([^\p{L}]|$)|serial|серийн|заводск/iu';
	private const MODEL = '/модел|model|марка/iu';
	private const ARTICLE = '/артикул|article|artnumber/iu';

	/** @return array<int, string> ID инфоблока → название */
	public static function iblocks(array $s): array
	{
		Portal::need('iblock');
		$ids = $s['catalog_iblock_ids'];
		if (!$ids)
		{
			Portal::need('catalog');
			$rows = \Bitrix\Catalog\CatalogIblockTable::getList(['select' => ['IBLOCK_ID', 'PRODUCT_IBLOCK_ID']]);
			while ($row = $rows->fetch())
			{
				// Инфоблок торговых предложений ссылается на свой инфоблок товаров — его пропускаем.
				if ((int)$row['PRODUCT_IBLOCK_ID'] === 0)
				{
					$ids[] = (int)$row['IBLOCK_ID'];
				}
			}
		}
		$out = [];
		foreach ($ids as $id)
		{
			$iblock = \CIBlock::GetArrayByID($id);
			if (is_array($iblock))
			{
				$out[$id] = Text::clean((string)$iblock['NAME']);
			}
		}
		if (!$out)
		{
			throw new AppError('На портале не найден каталог товаров — укажите его во вкладке «Проверка»');
		}

		return $out;
	}

	public static function vinFields(array $s, int $iblockId): array
	{
		return $s['vin_fields'] ? Fields::own($iblockId, $s['vin_fields']) : Fields::matching($iblockId, self::VIN);
	}

	public static function modelFields(array $s, int $iblockId): array
	{
		return $s['model_fields'] ? Fields::own($iblockId, $s['model_fields']) : Fields::matching($iblockId, self::MODEL);
	}

	private static array $properties = [];

	/**
	 * Свойство «Модификация» этого каталога: откуда берётся «Марка модель» строки. Ищется по коду
	 * (MODIFIKATSIYA, без учёта регистра), а нет такого кода — по названию «Модификация…» (byName).
	 * Свойство-список отдаёт текст значения. null — у каталога такого свойства нет.
	 */
	public static function modificationProperty(array $s, int $iblockId): ?array
	{
		return self::property($iblockId, $s['modification_code'], '/^\s*модификац/iu');
	}

	/**
	 * Свойство «Декларация» (DECLARACIA, только по коду): заполнено у товара — его VIN уже был
	 * в декларации, и новый элемент по нему не создаётся. null — свойства нет, проверка не идёт.
	 */
	public static function declarationProperty(array $s, int $iblockId): ?array
	{
		return self::property($iblockId, $s['declaration_code'], null);
	}

	private static function property(int $iblockId, string $code, ?string $namePattern): ?array
	{
		$key = $iblockId . ':' . $code . ':' . (string)$namePattern;
		if (!array_key_exists($key, self::$properties))
		{
			Portal::need('iblock');
			$byCode = null;
			$byName = null;
			$rows = PropertyTable::getList([
				'select' => ['ID', 'NAME', 'CODE', 'PROPERTY_TYPE', 'USER_TYPE'],
				'filter' => ['=IBLOCK_ID' => $iblockId],
				'order' => ['SORT' => 'ASC', 'ID' => 'ASC'],
			]);
			while ($row = $rows->fetch())
			{
				if (strtoupper(trim((string)$row['CODE'])) === $code)
				{
					$byCode = $row;
					break;
				}
				if ($namePattern !== null && $byName === null && preg_match($namePattern, (string)$row['NAME']))
				{
					$byName = $row;
				}
			}
			$row = $byCode ?? $byName;
			self::$properties[$key] = $row ? [
				'field' => 'PROPERTY_' . (int)$row['ID'],
				'name' => Text::clean((string)$row['NAME']),
				'code' => (string)$row['CODE'],
				'type' => (string)$row['PROPERTY_TYPE'],
				'userType' => (string)$row['USER_TYPE'],
				'byName' => $byCode === null,
			] : null;
		}

		return self::$properties[$key];
	}

	/**
	 * Значения свойства по товарам в текст: список и строка — как есть,
	 * привязка к элементу — название элемента. @param array<int, string[]> $values ID товара → значения
	 */
	private static function propertyText(?array $property, array $values): array
	{
		if ($property !== null && $property['type'] === 'E')
		{
			$ids = [];
			foreach ($values as $list)
			{
				foreach ($list as $value)
				{
					$ids[(int)$value] = (int)$value;
				}
			}
			$names = [];
			$ids = array_values(array_filter($ids));
			if ($ids)
			{
				$rows = \Bitrix\Iblock\ElementTable::getList(['select' => ['ID', 'NAME'], 'filter' => ['@ID' => $ids]]);
				while ($row = $rows->fetch())
				{
					$names[(int)$row['ID']] = Text::clean((string)$row['NAME']);
				}
			}
			foreach ($values as $id => $list)
			{
				$values[$id] = array_map(static function ($value) use ($names) {
					return $names[(int)$value] ?? (string)$value;
				}, $list);
			}
		}
		$out = [];
		foreach ($values as $id => $list)
		{
			$out[$id] = implode(', ', array_unique(array_filter(array_map('strval', $list), 'strlen')));
		}

		return $out;
	}

	/**
	 * Товары по ID — при отправке и при открытии страницы: есть ли ещё в каталоге, их модификация
	 * и «Декларация» (берутся из каталога, а не из браузера).
	 * @return array<int, array{id:int, name:string, modification:string, declaration:string}>
	 */
	public static function products(array $s, array $ids): array
	{
		$ids = Settings::ids($ids);
		if (!$ids)
		{
			return [];
		}
		Portal::need('iblock');
		$byIblock = [];
		$rows = \Bitrix\Iblock\ElementTable::getList(['select' => ['ID', 'IBLOCK_ID'], 'filter' => ['@ID' => $ids]]);
		while ($row = $rows->fetch())
		{
			$byIblock[(int)$row['IBLOCK_ID']][] = (int)$row['ID'];
		}
		$out = [];
		foreach ($byIblock as $iblockId => $list)
		{
			$props = ['modification' => self::modificationProperty($s, $iblockId), 'declaration' => self::declarationProperty($s, $iblockId)];
			$select = ['ID', 'IBLOCK_ID', 'NAME'];
			foreach ($props as $property)
			{
				if ($property !== null)
				{
					$select[] = $property['field'];
				}
			}
			$values = ['modification' => [], 'declaration' => []];
			$rows = \CIBlockElement::GetList([], ['ID' => $list, 'IBLOCK_ID' => $iblockId, 'CHECK_PERMISSIONS' => 'N'], false, false, array_values(array_unique($select)));
			while ($row = $rows->Fetch())
			{
				$id = (int)$row['ID'];
				$out[$id] = $out[$id] ?? ['id' => $id, 'name' => Text::clean(Text::scalar($row['NAME'])), 'modification' => '', 'declaration' => ''];
				foreach ($props as $kind => $property)
				{
					$values[$kind][$id] = $values[$kind][$id] ?? [];
					$value = $property !== null ? Fields::value($row, $property['field']) : '';
					if ($value !== '')
					{
						$values[$kind][$id][] = $value;
					}
				}
			}
			foreach ($props as $kind => $property)
			{
				foreach (self::propertyText($property, $values[$kind]) as $id => $text)
				{
					$out[$id][$kind] = $text;
				}
			}
		}

		return $out;
	}

	/**
	 * Товары с этим VIN — точное совпадение, как в app.js findVin: в карточке VIN бывает не один
	 * («4583/X89777222R0EV8014»). Для строк, где товар не выбран: был ли VIN уже в декларации.
	 */
	public static function byVin(array $s, string $vin): array
	{
		$key = self::key($vin);
		if (mb_strlen($key) < self::MIN_QUERY)
		{
			return [];
		}
		$out = [];
		foreach (self::search($s, $vin)['items'] as $item)
		{
			$parts = array_merge([$item['vin'] !== '' ? $item['vin'] : $item['name']], preg_split('/[\s,;\/]+/u', $item['vin']) ?: []);
			foreach ($parts as $part)
			{
				if (self::key((string)$part) === $key)
				{
					$out[] = $item;
					break;
				}
			}
		}

		return $out;
	}

	public static function search(array $s, string $query): array
	{
		$text = Text::clean((string)preg_replace('/[^\p{L}\p{N}\-\/.,]+/u', ' ', $query));
		if (mb_strlen(str_replace(' ', '', $text)) < self::MIN_QUERY)
		{
			return ['items' => [], 'more' => false];
		}
		$variants = array_values(array_unique([$text, str_replace(' ', '', $text)]));
		$items = [];
		foreach (self::iblocks($s) as $iblockId => $iblockName)
		{
			$items = array_merge($items, self::find($s, $iblockId, $iblockName, $variants));
		}
		$key = self::key($text);
		usort($items, static function (array $a, array $b) use ($key) {
			return self::rank($a, $key) <=> self::rank($b, $key) ?: strcmp($a['vin'] . $a['name'], $b['vin'] . $b['name']);
		});

		return ['items' => array_slice($items, 0, self::LIMIT), 'more' => count($items) > self::LIMIT];
	}

	/** Выше — совпадение VIN с начала, потом VIN где угодно, потом название. */
	private static function rank(array $item, string $key): int
	{
		$vin = self::key($item['vin']);
		if ($vin !== '' && strpos($vin, $key) === 0)
		{
			return 0;
		}
		if ($vin !== '' && strpos($vin, $key) !== false)
		{
			return 1;
		}

		return 2;
	}

	private static function key(string $text): string
	{
		return (string)preg_replace('/[^\p{L}\p{N}]+/u', '', mb_strtoupper($text));
	}

	private static function find(array $s, int $iblockId, string $iblockName, array $variants): array
	{
		$vinFields = array_values(array_diff(self::vinFields($s, $iblockId), ['NAME']));
		$modelFields = array_values(array_diff(self::modelFields($s, $iblockId), ['NAME']));
		$modification = self::modificationProperty($s, $iblockId);
		$modificationFields = $modification !== null ? [$modification['field']] : [];
		$declaration = self::declarationProperty($s, $iblockId);
		$declarationFields = $declaration !== null ? [$declaration['field']] : [];
		$searchFields = array_values(array_unique(array_merge(['NAME'], $vinFields, $modelFields,
			Fields::matching($iblockId, self::ARTICLE))));
		$any = ['LOGIC' => 'OR'];
		foreach ($variants as $variant)
		{
			foreach ($searchFields as $field)
			{
				$any[] = ['%' . $field => $variant];
			}
		}
		$select = array_values(array_unique(array_merge(['ID', 'IBLOCK_ID', 'NAME', 'IBLOCK_SECTION_ID'], $vinFields, $modelFields,
			$modificationFields, $declarationFields)));
		$rows = \CIBlockElement::GetList(
			['NAME' => 'ASC', 'ID' => 'ASC'],
			[
				$any,
				'IBLOCK_ID' => $iblockId,
				'ACTIVE' => 'Y',
				// Права смотрим сами — вкладкой «Доступ»; каталог сотруднику открывать не нужно.
				'CHECK_PERMISSIONS' => 'N',
			],
			false,
			['nTopCount' => self::LIMIT + 1],
			$select
		);
		$items = [];
		while ($row = $rows->Fetch())
		{
			$id = (int)$row['ID'];
			if ((int)$row['IBLOCK_ID'] !== $iblockId)
			{
				continue;
			}
			// Свойство с несколькими значениями размножает строку товара — собираем в одну карточку.
			if (!isset($items[$id]))
			{
				$items[$id] = [
					'id' => $id,
					'name' => Text::clean(Text::scalar($row['NAME'])),
					'section' => (int)$row['IBLOCK_SECTION_ID'],
					'vin' => [],
					'model' => [],
					'modification' => [],
					'declaration' => [],
				];
			}
			foreach (['vin' => $vinFields, 'model' => $modelFields, 'modification' => $modificationFields, 'declaration' => $declarationFields] as $kind => $fields)
			{
				foreach ($fields as $field)
				{
					$value = Fields::value($row, $field);
					if ($value !== '')
					{
						$items[$id][$kind][$value] = $value;
					}
				}
			}
		}
		$sections = self::sectionNames($iblockId, array_column($items, 'section'));
		$modificationText = self::propertyText($modification, array_map(static function (array $item) {
			return array_values($item['modification']);
		}, $items));
		$declarationText = self::propertyText($declaration, array_map(static function (array $item) {
			return array_values($item['declaration']);
		}, $items));
		foreach ($items as $id => &$item)
		{
			$item['section'] = $sections[$item['section']] ?? $iblockName;
			$item['vin'] = implode(', ', $item['vin']);
			$item['model'] = implode(', ', $item['model']);
			$item['modification'] = $modificationText[$id] ?? '';
			$item['declaration'] = $declarationText[$id] ?? '';
		}
		unset($item);

		return array_values($items);
	}

	/** @return array<int, string> ID папки → название */
	private static function sectionNames(int $iblockId, array $ids): array
	{
		$ids = array_values(array_filter(array_unique(array_map('intval', $ids))));
		if (!$ids)
		{
			return [];
		}
		$out = [];
		$rows = SectionTable::getList([
			'select' => ['ID', 'NAME'],
			'filter' => ['@ID' => $ids, '=IBLOCK_ID' => $iblockId],
		]);
		while ($row = $rows->fetch())
		{
			$out[(int)$row['ID']] = Text::clean((string)$row['NAME']);
		}

		return $out;
	}
}


/**
 * Колонки-списки строки: «Резерв (где растоможили)» и «Орган въезда/выезда» — поля-списки
 * смарт-процесса (код поля или его ID — в настройках). В строке хранится ID значения; в БП оно
 * уходит ключом, который ждёт параметр шаблона (в CRM — XML_ID, см. Process::listValue).
 * Если при загрузке XML значение не подобралось из списка, колонка этой строки открыта для
 * ручного ввода (row.free) — уйдёт, только если такое значение есть в списке параметра.
 */
final class Lists
{
	public const COLUMNS = [
		'reserve' => ['setting' => 'reserve_field', 'label' => 'Резерв (где растоможили)',
			'fallback' => [['id' => 2494, 'name' => '10504080, Г.ЧЕЛЯБИНСК'], ['id' => 2495, 'name' => '10719110, ЗАБАЙКАЛЬСКИЙ КРАЙ']]],
		'organ' => ['setting' => 'organ_field', 'label' => 'Орган въезда/выезда',
			'fallback' => [['id' => 2496, 'name' => '39857301 Т/П "Бахты"'], ['id' => 2497, 'name' => '10719110 Т/П "МАПП ЗАБАЙКАЛЬСК"']]],
	];

	private static array $cache = [];

	/** @return array{options: array, error: string, field: ?array, code: string} */
	public static function options(array $s, string $column): array
	{
		$info = self::COLUMNS[$column];
		$code = (string)($s[$info['setting']] ?? '');
		$key = $column . ':' . $code;
		if (isset(self::$cache[$key]))
		{
			return self::$cache[$key];
		}
		$fallback = static function (string $error, ?array $field = null) use ($info, $code): array {
			$names = implode(', ', array_map(static function (array $option) {
				return $option['name'] . ' (' . $option['id'] . ')';
			}, $info['fallback']));

			return ['options' => $info['fallback'], 'field' => $field, 'code' => $code,
				'error' => $error . ($names !== '' ? ' — в списке значения по умолчанию: ' . $names : ' — список пуст')];
		};
		if ($code === '')
		{
			return self::$cache[$key] = ['options' => [], 'field' => null, 'code' => '',
				'error' => 'Поле-список не задано — впишите его код или ID в настройках. Пока значения из XML встают текстом'];
		}
		try
		{
			$filter = ctype_digit($code) ? ['ID' => (int)$code] : ['FIELD_NAME' => $code];
			$row = \CUserTypeEntity::GetList([], $filter + ['LANG' => defined('LANGUAGE_ID') ? LANGUAGE_ID : 'ru'])->Fetch();
			if (!is_array($row))
			{
				$out = $fallback('Поле ' . $code . ' не найдено на портале');
			}
			else
			{
				$field = [
					'id' => (int)$row['ID'],
					'name' => (string)$row['FIELD_NAME'],
					'entity' => (string)$row['ENTITY_ID'],
					'label' => Text::clean(Text::scalar($row['EDIT_FORM_LABEL'] ?? '')),
					'type' => (string)$row['USER_TYPE_ID'],
				];
				$options = [];
				if ($field['type'] === 'enumeration')
				{
					$rows = \CUserFieldEnum::GetList(['SORT' => 'ASC', 'ID' => 'ASC'], ['USER_FIELD_ID' => $field['id']]);
					while ($item = $rows->Fetch())
					{
						$options[] = ['id' => (int)$item['ID'], 'name' => Text::clean(Text::scalar($item['VALUE']))];
					}
				}
				if ($field['type'] !== 'enumeration')
				{
					$out = $fallback('Поле ' . $field['name'] . ' — не список (' . $field['type'] . ')', $field);
				}
				elseif (!$options)
				{
					$out = $fallback('В списке ' . $field['name'] . ' нет значений', $field);
				}
				else
				{
					$out = ['options' => $options, 'error' => '', 'field' => $field, 'code' => $code];
				}
			}
		}
		catch (\Throwable $e)
		{
			$out = $fallback('Список ' . $code . ' не прочитан: ' . $e->getMessage());
		}

		return self::$cache[$key] = $out;
	}

	/** Значения для страницы: колонка => [{id, name}]. */
	public static function boot(array $s): array
	{
		$out = [];
		foreach (array_keys(self::COLUMNS) as $column)
		{
			$out[$column] = ['options' => self::options($s, $column)['options']];
		}

		return $out;
	}

	/** Смарт-процесс, которому принадлежит поле (CRM_14 → entityTypeId), или 0. */
	public static function entityTypeId(array $s, string $column): int
	{
		$field = self::options($s, $column)['field'];
		if ($field === null || !preg_match('/^CRM_(\d+)$/', $field['entity'], $m) || !Loader::includeModule('crm'))
		{
			return 0;
		}
		try
		{
			$row = \Bitrix\Crm\Model\Dynamic\TypeTable::getById((int)$m[1])->fetch();
		}
		catch (\Throwable $e)
		{
			return 0;
		}

		return $row ? (int)$row['ENTITY_TYPE_ID'] : 0;
	}

	/**
	 * Значение колонки → ID значения списка: «2494» → 2494, «Челябинск» → 2494.
	 * Не нашлось в списке — null.
	 */
	public static function resolve(array $s, string $column, string $value): ?int
	{
		$value = trim($value);
		if ($value === '')
		{
			return null;
		}
		foreach (self::options($s, $column)['options'] as $option)
		{
			if ((string)$option['id'] === $value || mb_strtolower((string)$option['name']) === mb_strtolower($value))
			{
				return (int)$option['id'];
			}
		}

		return null;
	}

	/** Колонки строки, открытые для ручного ввода: при загрузке XML значение не подобралось из списка. */
	public static function free($value): array
	{
		$out = [];
		foreach (is_array($value) ? $value : [] as $column)
		{
			$column = Text::scalar($column);
			if (isset(self::COLUMNS[$column]))
			{
				$out[$column] = $column;
			}
		}

		return array_values($out);
	}
}


// ---------- база: декларации и журнал ----------

/**
 * Свои таблицы в базе портала. Создаются сами (install.php или первый запрос),
 * при замене файлов программы не трогаются. MySQL/MariaDB и PostgreSQL.
 */
final class Db
{
	public const DECL = 'gross_dt_decl';
	public const LOG = 'gross_dt_log';

	private static bool $ready = false;

	public static function ensure(): void
	{
		if (self::$ready)
		{
			return;
		}
		$connection = Application::getConnection();
		$mysql = $connection->getType() !== 'pgsql';
		$long = $mysql ? 'longtext' : 'text';
		$tail = $mysql ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : '';
		if (!$connection->isTableExists(self::DECL))
		{
			$connection->queryExecute('CREATE TABLE ' . self::DECL . ' ('
				. 'id varchar(32) NOT NULL, '
				. 'dt varchar(100) NOT NULL, '
				. "status varchar(10) NOT NULL DEFAULT 'draft', "
				. 'data ' . $long . ' NOT NULL, '
				. "created_at varchar(32) NOT NULL DEFAULT '', "
				. 'created_by integer NOT NULL DEFAULT 0, '
				. "updated_at varchar(32) NOT NULL DEFAULT '', "
				. 'updated_by integer NOT NULL DEFAULT 0, '
				. "sent_at varchar(32) NOT NULL DEFAULT '', "
				. 'sent_by integer NOT NULL DEFAULT 0, '
				. 'PRIMARY KEY (id), '
				. 'CONSTRAINT ux_gross_dt_decl_dt UNIQUE (dt)'
				. ')' . $tail);
		}
		if (!$connection->isTableExists(self::LOG))
		{
			$connection->queryExecute('CREATE TABLE ' . self::LOG . ' ('
				. 'id varchar(32) NOT NULL, '
				. 'ts bigint NOT NULL, '
				. 'user_id integer NOT NULL DEFAULT 0, '
				. "user_name varchar(255) NOT NULL DEFAULT '', "
				. "act varchar(64) NOT NULL DEFAULT '', "
				. 'data ' . $long . ' NOT NULL, '
				. 'PRIMARY KEY (id)'
				. ')' . $tail);
			$connection->queryExecute('CREATE INDEX ix_gross_dt_log_ts ON ' . self::LOG . ' (ts)');
		}
		self::$ready = true;
	}

	/** Строка в кавычках для SQL. */
	public static function str(string $value): string
	{
		return "'" . Application::getConnection()->getSqlHelper()->forSql($value) . "'";
	}

	public static function rows(string $sql): array
	{
		self::ensure();
		$out = [];
		$result = Application::getConnection()->query($sql);
		while ($row = $result->fetch())
		{
			$out[] = array_change_key_case($row, CASE_LOWER);
		}

		return $out;
	}

	public static function exec(string $sql): void
	{
		self::ensure();
		Application::getConnection()->queryExecute($sql);
	}

	public static function json(array $data): string
	{
		$json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
		if ($json === false)
		{
			throw new AppError('Не удалось сохранить данные: ' . json_last_error_msg());
		}

		return $json;
	}
}

/**
 * Колонки строки и формулы — те же, что FIELDS в app.js (порядок листа
 * «Себестоимость после 01.26»). Курс и проценты — общие для декларации.
 * Сервер пересчитывает формулы сам при отправке.
 */
final class Formula
{
	public const TEXT = ['vin', 'contract', 'reserve', 'organ', 'dateExit', 'dateArrival'];
	public const MONEY = ['amountY', 'delivery', 'fees', 'duty', 'vat', 'util', 'broker', 'svh', 'parking', 'rail', 'pts', 'loading'];
	// «Сумма» — как в Excel (=K+L+M+N+O+Q+R+S+T+U): из доп. расходов только «ЖД в России».
	public const SUM = ['cost', 'delivery', 'fees', 'duty', 'vat', 'utilVat', 'broker', 'svh', 'parking', 'rail'];
	public const LABELS = [
		'amountY' => 'отправка в Китай', 'delivery' => 'доставка до таможни', 'fees' => 'сборы', 'duty' => 'пошлина',
		'vat' => 'НДС', 'util' => 'утиль сбор', 'broker' => 'брокерские', 'svh' => 'СВХ', 'parking' => 'стоянка',
		'rail' => 'ЖД в России', 'pts' => 'ПТС ПСМ быстрота', 'loading' => 'доп. расходы с погрузкой/выгрузкой',
	];

	/** Колонки «авто». Пусто в строке — формула; число — вписано вручную и заменяет формулу. */
	public const AUTO = ['cost', 'utilVat', 'sum', 'total'];
	private const AUTO_LABELS = ['cost' => 'стоимость в рублях', 'utilVat' => 'утиль сбор с НДС', 'sum' => 'сумма', 'total' => 'НДС от маржи'];

	public static function inputs(): array
	{
		return array_merge(self::TEXT, self::MONEY, self::AUTO);
	}

	/** Число из «1 243 014,32». Пусто — null, не число — false. */
	public static function num(string $value)
	{
		$text = str_replace(',', '.', (string)preg_replace('/[\s\x{00A0}\x{202F}]+/u', '', $value));
		if ($text === '')
		{
			return null;
		}

		return preg_match('/^\d+(\.\d+)?$/', $text) ? (float)$text : false;
	}

	public static function decimals(string $value): int
	{
		$text = str_replace(',', '.', (string)preg_replace('/[\s\x{00A0}\x{202F}]+/u', '', $value));
		$at = strpos($text, '.');

		return $at === false ? 0 : strlen($text) - $at - 1;
	}

	public static function vinKey(string $vin): string
	{
		return mb_strtoupper((string)preg_replace('/[^\p{L}\p{N}]+/u', '', $vin));
	}

	/** Значения строки числами плюс формулы — как в Excel. */
	public static function values(array $row, ?float $rate, float $utilPct, float $extraPct): array
	{
		$v = [];
		$invalid = false;
		foreach (self::MONEY as $key)
		{
			$n = self::num((string)($row[$key] ?? ''));
			$invalid = $invalid || $n === false;
			$v[$key] = is_float($n) ? $n : null;
		}
		// Вписанное вручную в ячейку «авто» заменяет формулу, и дальше считается уже от него.
		$manual = [];
		foreach (self::AUTO as $key)
		{
			$n = self::num((string)($row[$key] ?? ''));
			$invalid = $invalid || $n === false;
			$manual[$key] = is_float($n) ? $n : null;
		}
		$v['rate'] = $rate;
		$v['cost'] = $manual['cost'] ?? ($v['amountY'] !== null && $rate !== null ? $v['amountY'] * $rate : null);
		$v['utilVat'] = $manual['utilVat'] ?? ($v['util'] !== null ? $v['util'] * $utilPct / 100 + $v['util'] : null);
		$sum = null;
		if (!$invalid)
		{
			foreach (self::SUM as $key)
			{
				if ($v[$key] !== null)
				{
					$sum = ($sum ?? 0.0) + $v[$key];
				}
			}
		}
		$v['sum'] = $manual['sum'] ?? $sum;
		$v['total'] = $manual['total'] ?? ($v['sum'] !== null ? $v['sum'] * $extraPct / 100 + $v['sum'] : null);
		foreach ($v as $key => $value)
		{
			if ($value !== null && $key !== 'rate')
			{
				$v[$key] = round($value, 2);
			}
		}

		return $v;
	}

	public static function rateProblem(string $rate): string
	{
		$n = self::num($rate);
		if (!is_float($n) || self::decimals($rate) !== 4)
		{
			return 'курс по ДТ — нужно ровно 4 знака после запятой';
		}

		return $n > 0 ? '' : 'курс по ДТ не может быть нулевым';
	}

	/** Что мешает отправить строку. Колонки-списки проверяет Decls::queue (им нужны настройки). */
	public static function problems(array $row): array
	{
		$out = [];
		if (trim((string)($row['vin'] ?? '')) === '')
		{
			$out[] = 'не указан VIN';
		}
		$amount = self::num((string)($row['amountY'] ?? ''));
		if (!is_float($amount) || $amount <= 0)
		{
			$out[] = 'не указана отправка в Китай';
		}
		foreach (self::MONEY as $key)
		{
			$value = (string)($row[$key] ?? '');
			if (self::num($value) === false || self::decimals($value) > 2)
			{
				$out[] = 'не число: ' . self::LABELS[$key];
			}
		}
		foreach (self::AUTO as $key)
		{
			$value = (string)($row[$key] ?? '');
			if (self::num($value) === false || self::decimals($value) > 2)
			{
				$out[] = 'не число: ' . self::AUTO_LABELS[$key];
			}
		}

		return $out;
	}
}

/**
 * Декларации: одна ДТ — одна декларация со строками. Общие для всех, у кого есть доступ.
 * Статусы: draft — черновик; sending — отправка в БП началась, ушли не все строки
 * (правки закрыты, «Отправить» продолжает); sent — все строки ушли в БП.
 */
final class Decls
{
	private const MAX_ROWS = 2000;
	private const STATUSES = ['draft', 'sending', 'sent'];
	/** Столько секунд один запрос запускает строки; остальные — следующим запросом страницы. */
	private const SEND_BUDGET = 12.0;

	/** Декларации в работе. Отправленные в приложении не показываются — их находят по номеру ДТ (Archive) и открывают снова. */
	public static function all(): array
	{
		$out = [];
		foreach (Db::rows('SELECT * FROM ' . Db::DECL . " WHERE status <> 'sent' ORDER BY created_at DESC, id ASC") as $row)
		{
			$out[] = self::unpack($row);
		}

		return $out;
	}

	/**
	 * Открыть отправленную декларацию снова: она возвращается в работу со всеми строками,
	 * её можно править и отправить ещё раз (каждая строка — новый запуск БП).
	 * Курс и проценты — из блока «Новая декларация», если их там поменяли.
	 */
	public static function reopen($input, array $user): array
	{
		$in = is_array($input) ? $input : [];
		$id = self::id(Text::scalar($in['id'] ?? ''));
		$old = self::row($id);
		if ($old === null)
		{
			throw new AppError('Декларация не найдена — наберите номер ДТ ещё раз');
		}
		if ($old['status'] !== 'sent')
		{
			return ['item' => self::unpack($old)];
		}
		$data = $old['data'];
		$rate = (string)preg_replace('/[\s\x{00A0}\x{202F}]+/u', '', Text::short($in['rate'] ?? '', 32));
		if ($rate !== '')
		{
			$data['rate'] = $rate;
		}
		foreach (['utilPct', 'extraPct'] as $key)
		{
			$n = Formula::num(Text::scalar($in[$key] ?? ''));
			if (is_float($n) && $n <= 100)
			{
				$data[$key] = $n;
			}
		}
		// Прошлая отправка нигде не показывается: следующая начнётся с чистого листа.
		unset($data['queue'], $data['launches'], $data['sentBy'], $data['sendStartedAt'], $data['sendStartedBy']);
		Db::exec('UPDATE ' . Db::DECL . " SET status = 'draft', data = " . Db::str(Db::json($data))
			. ", sent_at = '', sent_by = 0, updated_at = " . Db::str(now()) . ', updated_by = ' . $user['id']
			. ' WHERE id = ' . Db::str($id) . " AND status = 'sent'");

		return ['item' => self::unpack(self::row($id))];
	}

	public static function save($input, array $user): array
	{
		$item = self::clean(is_array($input) ? $input : []);
		$old = self::row($item['id']);
		if ($old !== null && $old['status'] !== 'draft')
		{
			throw new AppError('Декларация ДТ ' . $old['dt'] . ($old['status'] === 'sent' ? ' уже отправлена' : ' отправляется в бизнес-процесс')
				. ' — изменения не принимаются');
		}
		$taken = Db::rows('SELECT id, status FROM ' . Db::DECL . ' WHERE dt = ' . Db::str($item['dt']) . ' AND id <> ' . Db::str($item['id']));
		if ($taken)
		{
			throw new AppError($taken[0]['status'] === 'sent'
				? 'ДТ ' . $item['dt'] . ' уже отправлялась — наберите её номер в «Новой декларации» и выберите из списка'
				: 'ДТ ' . $item['dt'] . ' уже есть в другой декларации');
		}
		$who = ['id' => $user['id'], 'name' => $user['name']];
		$time = now();
		if ($old === null)
		{
			$data = self::data($item, $who, $time);
			Db::exec('INSERT INTO ' . Db::DECL . ' (id, dt, status, data, created_at, created_by, updated_at, updated_by) VALUES ('
				. Db::str($item['id']) . ', ' . Db::str($item['dt']) . ", 'draft', " . Db::str(Db::json($data)) . ', '
				. Db::str($time) . ', ' . $user['id'] . ', ' . Db::str($time) . ', ' . $user['id'] . ')');
		}
		else
		{
			$data = self::data($item, $old['data']['createdBy'] ?? $who, $old['created_at']);
			Db::exec('UPDATE ' . Db::DECL . ' SET dt = ' . Db::str($item['dt']) . ', data = ' . Db::str(Db::json($data))
				. ', updated_at = ' . Db::str($time) . ', updated_by = ' . $user['id']
				. ' WHERE id = ' . Db::str($item['id']) . " AND status = 'draft'");
		}

		return ['item' => self::unpack(self::row($item['id']))];
	}

	public static function delete(string $id): void
	{
		$old = self::row(self::id($id));
		if ($old === null)
		{
			return;
		}
		if ($old['status'] !== 'draft')
		{
			throw new AppError('Отправленную декларацию удалить нельзя');
		}
		Db::exec('DELETE FROM ' . Db::DECL . ' WHERE id = ' . Db::str($old['id']) . " AND status = 'draft'");
	}

	/**
	 * «Отправить» одну декларацию: каждая строка — отдельный запуск шаблона БП с её значениями.
	 * Проверяем сохранённую декларацию (а не присланную браузером), пересчитываем формулы,
	 * закрываем её для правок и запускаем строки, пока хватает времени запроса. Запущенная
	 * строка запоминается сразу — повтор запроса её не запускает второй раз.
	 */
	public static function send(string $id, array $user, array $s): array
	{
		$id = self::id($id);
		$db = Application::getConnection();
		$lock = 'gross_dt_' . $id;
		$locking = method_exists($db, 'lock');
		if ($locking && !$db->lock($lock, 20))
		{
			throw new AppError('Эту декларацию сейчас отправляет другой сотрудник — дождитесь окончания');
		}
		try
		{
			return self::sendLocked($id, $user, $s);
		}
		finally
		{
			if ($locking)
			{
				$db->unlock($lock);
			}
		}
	}

	private static function sendLocked(string $id, array $user, array $s): array
	{
		$old = self::row($id);
		if ($old === null)
		{
			throw new AppError('Декларация не найдена — обновите страницу');
		}
		if ($old['status'] === 'sent')
		{
			return ['item' => self::unpack($old), 'error' => '', 'warnings' => []];
		}
		$template = Process::forLaunch($s);
		$data = $old['data'];
		if ($old['status'] === 'draft')
		{
			// Всё проверяется до первого запуска: ошибка в строке 7 не должна оставить полдекларации в БП.
			$data['queue'] = self::queue($old, $s, $template, $user);
			$data['launches'] = [];
			$data['sendStartedAt'] = now();
			$data['sendStartedBy'] = ['id' => $user['id'], 'name' => $user['name']];
			self::store($id, 'sending', $data, 'draft');
		}
		$queue = is_array($data['queue'] ?? null) ? $data['queue'] : [];
		$data['launches'] = is_array($data['launches'] ?? null) ? $data['launches'] : [];
		$deadline = microtime(true) + self::SEND_BUDGET;
		$error = '';
		$warnings = [];
		foreach (Process::listGaps($s, $template) as $code => $gap)
		{
			$warnings[] = 'в шаблоне БП, в блоке «Создать элемент», поле «' . Bp::PARAMS[$code][0] . '» (' . $gap['field']
				. ') не берётся из параметра ' . $code . ' — ' . ($gap['value'] !== '' ? 'там стоит «' . $gap['value'] . '»' : 'там пусто')
				. '. Поставьте в это поле параметр шаблона, иначе в элементе оно пустое';
		}
		$started = 0;
		foreach ($queue as $task)
		{
			if (isset($data['launches'][$task['rowId']]))
			{
				continue;
			}
			if ($started > 0 && microtime(true) > $deadline)
			{
				break;
			}
			try
			{
				$launch = Process::start($template, Process::parameters($template, $task['params']), $user['id']);
			}
			catch (\Throwable $e)
			{
				if (!$e instanceof AppError)
				{
					error_log('gross.declarations bp: ' . $e);
				}
				$launch = ['workflowId' => '', 'itemId' => 0, 'warning' => '',
					'error' => $e instanceof AppError || Access::isOwner($user) ? $e->getMessage() : 'сбой — подробности в журнале сервера'];
			}
			if ($launch['error'] !== '')
			{
				$error = 'строка ' . $task['index'] . ' (VIN ' . $task['vin'] . ') не отправилась — ' . $launch['error'];
				break;
			}
			$data['launches'][$task['rowId']] = [
				'workflowId' => $launch['workflowId'],
				'itemId' => $launch['itemId'],
				'warning' => $launch['warning'],
				'at' => now(),
				'by' => $user['id'],
			];
			if ($launch['warning'] !== '')
			{
				$warnings[] = 'строка ' . $task['index'] . ': ' . $launch['warning'];
			}
			$started++;
			self::store($id, 'sending', $data, 'sending');
		}
		if ($error === '' && count($data['launches']) >= count($queue))
		{
			$data['sentBy'] = ['id' => $user['id'], 'name' => $user['name']];
			Db::exec('UPDATE ' . Db::DECL . " SET status = 'sent', data = " . Db::str(Db::json($data))
				. ', sent_at = ' . Db::str(now()) . ', sent_by = ' . $user['id']
				. ' WHERE id = ' . Db::str($id) . " AND status = 'sending'");
		}

		return ['item' => self::unpack(self::row($id)), 'error' => $error, 'warnings' => $warnings];
	}

	/** Строки на запуск: проверены, формулы пересчитаны, параметры БП собраны и сверены с шаблоном. */
	private static function queue(array $old, array $s, array $template, array $user): array
	{
		$data = $old['data'];
		if (!preg_match('~^\d+(?:/\d+)*$~', $old['dt']))
		{
			throw new AppError('номер ДТ — только цифры и дроби «/», между дробями — цифры');
		}
		$rate = self::rateOf($data);
		$problem = Formula::rateProblem($rate);
		if ($problem !== '')
		{
			throw new AppError($problem);
		}
		$rows = is_array($data['rows'] ?? null) ? $data['rows'] : [];
		if (!$rows)
		{
			throw new AppError('в декларации нет строк');
		}
		$products = Catalog::products($s, array_map(static function ($row) {
			return is_array($row['product'] ?? null) ? (int)($row['product']['id'] ?? 0) : 0;
		}, $rows));
		$elsewhere = self::vinsElsewhere($old);
		$vins = [];
		$queue = [];
		foreach ($rows as $index => $row)
		{
			$problems = Formula::problems($row);
			// Колонки-списки: название → ID значения (2494, 2495); ключ для шаблона — в Process::parameters.
			// Своё значение можно только там, где при загрузке XML ничего не подобралось (row.free).
			$free = Lists::free($row['free'] ?? null);
			foreach (Lists::COLUMNS as $column => $info)
			{
				$value = trim((string)($row[$column] ?? ''));
				$listId = Lists::resolve($s, $column, $value);
				if ($listId !== null)
				{
					$row[$column] = (string)$listId;
				}
				elseif ($value !== '' && !in_array($column, $free, true))
				{
					$problems[] = mb_strtolower($info['label']) . ' — выберите из списка';
				}
			}
			$key = Formula::vinKey((string)($row['vin'] ?? ''));
			if ($key !== '' && isset($vins[$key]))
			{
				$problems[] = 'VIN повторяется (строка ' . $vins[$key] . ')';
			}
			elseif ($key !== '' && isset($elsewhere[$key]))
			{
				$problems[] = 'VIN уже есть в ДТ ' . $elsewhere[$key];
			}
			$vins[$key] = $index + 1;
			$productId = is_array($row['product'] ?? null) ? (int)($row['product']['id'] ?? 0) : 0;
			if ($productId > 0 && !isset($products[$productId]))
			{
				$problems[] = 'товар #' . $productId . ' удалён из каталога — выберите VIN заново';
			}
			// VIN уже был в декларации: у товара заполнено свойство DECLARACIA — новый элемент не создаём.
			// Товар не выбран — ищем его по VIN в каталоге.
			$used = $productId > 0 ? (isset($products[$productId]) ? [$products[$productId]] : [])
				: ($key !== '' ? Catalog::byVin($s, (string)$row['vin']) : []);
			foreach ($used as $item)
			{
				if ((string)($item['declaration'] ?? '') !== '')
				{
					$problems[] = 'VIN уже был в декларации ' . $item['declaration'] . ' (свойство ' . $s['declaration_code']
						. ' товара #' . $item['id'] . ') — новый элемент по нему не создаётся';
					break;
				}
			}
			if ($problems)
			{
				throw new AppError('строка ' . ($index + 1) . ': ' . implode('; ', $problems));
			}
			$values = Formula::values($row, (float)Formula::num($rate), (float)($data['utilPct'] ?? 22), (float)($data['extraPct'] ?? 2.64));
			$params = Bp::params($old['dt'], $row, $values, $products[$productId] ?? null, $user);
			// Нет нужного параметра в шаблоне или значения в его списке — узнаём сейчас, до первого запуска.
			try
			{
				Process::parameters($template, $params);
			}
			catch (AppError $e)
			{
				throw new AppError(strpos($e->getMessage(), '«') === 0 ? 'строка ' . ($index + 1) . ': ' . $e->getMessage() : $e->getMessage());
			}
			$queue[] = ['rowId' => (string)$row['id'], 'index' => $index + 1, 'vin' => (string)$row['vin'], 'params' => $params];
		}

		return $queue;
	}

	/**
	 * VIN, которые эта декларация уступает другим — как на странице: главнее отправленные
	 * и начатые отправкой, дальше — созданные раньше. @return array<string, string> VIN → ДТ
	 */
	private static function vinsElsewhere(array $mine): array
	{
		$out = [];
		// Отправленные в приложении не видны — и повтором VIN не считаются, как и на странице.
		foreach (Db::rows('SELECT id, dt, status, created_at, data FROM ' . Db::DECL . ' WHERE id <> ' . Db::str($mine['id']) . " AND status <> 'sent'") as $other)
		{
			$first = $other['status'] !== 'draft'
				|| strcmp((string)$other['created_at'], (string)$mine['created_at']) < 0
				|| ((string)$other['created_at'] === (string)$mine['created_at'] && strcmp((string)$other['id'], (string)$mine['id']) < 0);
			if (!$first)
			{
				continue;
			}
			$data = json_decode((string)$other['data'], true);
			foreach (is_array($data['rows'] ?? null) ? $data['rows'] : [] as $row)
			{
				$key = Formula::vinKey((string)($row['vin'] ?? ''));
				if ($key !== '')
				{
					$out[$key] = $out[$key] ?? (string)$other['dt'];
				}
			}
		}

		return $out;
	}

	private static function store(string $id, string $status, array $data, string $from): void
	{
		Db::exec('UPDATE ' . Db::DECL . ' SET status = ' . Db::str($status) . ', data = ' . Db::str(Db::json($data))
			. ' WHERE id = ' . Db::str($id) . ' AND status = ' . Db::str($from));
	}

	public static function counts(): array
	{
		$out = ['draft' => 0, 'sending' => 0, 'sent' => 0];
		foreach (Db::rows('SELECT status, COUNT(*) AS cnt FROM ' . Db::DECL . ' GROUP BY status') as $row)
		{
			$out[$row['status']] = (int)$row['cnt'];
		}

		return $out;
	}

	private static function row(string $id): ?array
	{
		$rows = Db::rows('SELECT * FROM ' . Db::DECL . ' WHERE id = ' . Db::str($id));
		if (!$rows)
		{
			return null;
		}
		$row = $rows[0];
		$data = json_decode((string)$row['data'], true);
		$row['data'] = is_array($data) ? $data : ['rows' => []];

		return $row;
	}

	/** Курс декларации. В старых черновиках он был в каждой строке — берём первый непустой. */
	private static function rateOf(array $data): string
	{
		if (isset($data['rate']))
		{
			return (string)$data['rate'];
		}
		foreach (is_array($data['rows'] ?? null) ? $data['rows'] : [] as $row)
		{
			if (trim((string)($row['rate'] ?? '')) !== '')
			{
				return (string)$row['rate'];
			}
		}

		return '';
	}

	/** Декларация для браузера: данные плюс кто и когда. Параметры БП (queue) браузеру не нужны. */
	private static function unpack(array $row): array
	{
		$data = is_array($row['data']) ? $row['data'] : (json_decode((string)$row['data'], true) ?: []);
		$status = (string)$row['status'];

		return [
			'id' => (string)$row['id'],
			'dt' => (string)$row['dt'],
			'status' => in_array($status, self::STATUSES, true) ? $status : 'draft',
			'rate' => self::rateOf($data),
			'utilPct' => $data['utilPct'] ?? 22,
			'extraPct' => $data['extraPct'] ?? 2.64,
			'rows' => $data['rows'] ?? [],
			'launched' => is_array($data['launches'] ?? null) ? count($data['launches']) : 0,
			'launchTotal' => is_array($data['queue'] ?? null) ? count($data['queue']) : 0,
			'createdAt' => (string)$row['created_at'],
			'createdBy' => $data['createdBy'] ?? null,
			'updatedAt' => (string)$row['updated_at'],
			'sentAt' => (string)$row['sent_at'] !== '' ? (string)$row['sent_at'] : null,
			'sentBy' => $data['sentBy'] ?? null,
		];
	}

	private static function data(array $item, ?array $createdBy, string $createdAt): array
	{
		return [
			'rate' => $item['rate'],
			'utilPct' => $item['utilPct'],
			'extraPct' => $item['extraPct'],
			'rows' => $item['rows'],
			'createdBy' => $createdBy,
			'createdAt' => $createdAt,
		];
	}

	private static function id(string $id): string
	{
		if (!preg_match('/^[A-Za-z0-9_-]{1,32}$/', $id))
		{
			throw new AppError('Неверный идентификатор декларации');
		}

		return $id;
	}

	/** Только известные поля и разумной длины: браузеру не верим. */
	private static function clean(array $in): array
	{
		$dt = (string)preg_replace('/\s+/u', '', Text::scalar($in['dt'] ?? ''));
		// Только цифры и дроби «/», дробей сколько угодно, между ними — цифры.
		if (!preg_match('~^\d+(?:/\d+)*$~', $dt) || strlen($dt) > 100)
		{
			throw new AppError('Номер ДТ — только цифры и дроби «/», между дробями — цифры');
		}
		$rows = [];
		foreach (array_slice(is_array($in['rows'] ?? null) ? $in['rows'] : [], 0, self::MAX_ROWS) as $source)
		{
			if (!is_array($source))
			{
				continue;
			}
			$row = ['id' => self::id(Text::scalar($source['id'] ?? ''))];
			$product = is_array($source['product'] ?? null) ? $source['product'] : null;
			$row['product'] = $product && (int)Text::scalar($product['id'] ?? 0) > 0 ? [
				'id' => (int)Text::scalar($product['id']),
				'vin' => Text::short($product['vin'] ?? '', 200),
				'name' => Text::short($product['name'] ?? '', 255),
				'model' => Text::short($product['model'] ?? '', 255),
				'modification' => Text::short($product['modification'] ?? '', 255),
				'declaration' => Text::short($product['declaration'] ?? '', 255),
				'section' => Text::short($product['section'] ?? '', 255),
			] : null;
			foreach (Formula::inputs() as $key)
			{
				$row[$key] = Text::short($source[$key] ?? '', 255);
			}
			$row['free'] = Lists::free($source['free'] ?? null);
			$rows[] = $row;
		}
		$pct = static function ($value, float $default): float {
			$n = Formula::num(Text::scalar($value));

			return is_float($n) && $n <= 100 ? $n : $default;
		};

		return [
			'id' => self::id(Text::scalar($in['id'] ?? '')),
			'dt' => $dt,
			'rate' => (string)preg_replace('/[\s\x{00A0}\x{202F}]+/u', '', Text::short($in['rate'] ?? '', 32)),
			'utilPct' => $pct($in['utilPct'] ?? null, 22.0),
			'extraPct' => $pct($in['extraPct'] ?? null, 2.64),
			'rows' => $rows,
		];
	}
}


/**
 * Уже существующие декларации для поля «ДТ» в блоке «Новая декларация»: отправленные декларации
 * программы (их можно открыть снова) и ДТ, которые уже есть в Битриксе — у товаров заполнено
 * свойство «Декларация» (DECLARACIA) этим номером. Такую ДТ можно загрузить и отправить снова;
 * снова не отправить только VIN, которые уже были в декларации (Decls::queue).
 */
final class Archive
{
	private const LIMIT = 20;
	private const PORTAL_PRODUCTS = 300;

	public static function find(array $s, string $query): array
	{
		$out = self::sent($query);
		$known = array_column($out['items'], 'dt');
		try
		{
			$portal = self::portal($s, $query, false);
		}
		catch (\Throwable $e)
		{
			// Каталог недоступен — подсказки из программы всё равно нужны.
			$portal = [];
		}
		foreach ($portal as $dt => $info)
		{
			if (!in_array($dt, $known, true) && count($out['items']) < self::LIMIT)
			{
				// Все VIN этой ДТ: по ним декларация откроется со строками.
				$out['items'][] = ['id' => '', 'dt' => $dt, 'portal' => true, 'rows' => $info['rows'],
					'vins' => array_slice($info['vins'], 0, 200), 'rate' => '', 'sentAt' => ''];
			}
		}

		return $out;
	}

	/**
	 * ДТ, которые уже есть в Битриксе: у товаров заполнено свойство «Декларация» этим номером.
	 * $exact — только этот номер целиком. @return array<string, array{rows:int, vins:string[]}> ДТ → товары
	 */
	public static function portal(array $s, string $query, bool $exact): array
	{
		$q = (string)preg_replace('~[^\d/]+~', '', $query);
		if (strlen(str_replace('/', '', $q)) < 3 || !Loader::includeModule('iblock'))
		{
			return [];
		}
		$out = [];
		foreach (Catalog::iblocks($s) as $iblockId => $name)
		{
			$property = Catalog::declarationProperty($s, $iblockId);
			// Привязка к элементу хранит ID, а не номер ДТ — по ней номер не найти.
			if ($property === null || $property['type'] === 'E')
			{
				continue;
			}
			$filter = $property['field'] . ($property['type'] === 'L' ? '_VALUE' : '');
			$vinFields = array_values(array_diff(Catalog::vinFields($s, $iblockId), ['NAME']));
			$rows = \CIBlockElement::GetList(['ID' => 'DESC'],
				['IBLOCK_ID' => $iblockId, 'CHECK_PERMISSIONS' => 'N', '%' . $filter => $q],
				false, ['nTopCount' => self::PORTAL_PRODUCTS], array_values(array_unique(array_merge(['ID', 'IBLOCK_ID', 'NAME', $property['field']], $vinFields))));
			while ($row = $rows->Fetch())
			{
				$text = Fields::value($row, $property['field']);
				// В свойстве может быть не только номер: «ДТ 10009100/131026/5166277» — берём номера ДТ из текста.
				preg_match_all('~\d+(?:\s*/\s*\d+)+~u', $text, $m);
				$numbers = array_map(static function ($dt) {
					return (string)preg_replace('/\s+/u', '', $dt);
				}, $m[0] ?: [$text]);
				$vin = '';
				foreach ($vinFields as $field)
				{
					$vin = $vin !== '' ? $vin : Fields::value($row, $field);
				}
				$vin = $vin !== '' ? $vin : Text::clean(Text::scalar($row['NAME']));
				foreach (array_unique($numbers) as $dt)
				{
					if ($dt === '' || ($exact ? $dt !== $q : strpos($dt, $q) === false))
					{
						continue;
					}
					$out[$dt] = $out[$dt] ?? ['rows' => 0, 'vins' => [], 'ids' => []];
					if (!isset($out[$dt]['ids'][(int)$row['ID']]))
					{
						$out[$dt]['ids'][(int)$row['ID']] = true;
						$out[$dt]['rows']++;
						$out[$dt]['vins'][] = $vin;
					}
				}
			}
		}
		foreach ($out as &$info)
		{
			unset($info['ids']);
		}
		unset($info);

		return $out;
	}

	/** Отправленные декларации программы по части номера ДТ. */
	private static function sent(string $query): array
	{
		$q = (string)preg_replace('~[^\d/]+~', '', $query);
		if (strlen(str_replace('/', '', $q)) < 3)
		{
			return ['items' => []];
		}
		// В запросе только цифры и «/» — ни «%», ни «_» в LIKE не попадут.
		$rows = Db::rows('SELECT id, dt, data, sent_at FROM ' . Db::DECL . " WHERE status = 'sent' AND dt LIKE " . Db::str('%' . $q . '%')
			. ' ORDER BY sent_at DESC, dt ASC LIMIT ' . self::LIMIT);
		$items = [];
		foreach ($rows as $row)
		{
			$data = json_decode((string)$row['data'], true);
			$data = is_array($data) ? $data : [];
			$lines = is_array($data['rows'] ?? null) ? $data['rows'] : [];
			$vins = array_values(array_filter(array_map(static function ($line) {
				return trim((string)($line['vin'] ?? ''));
			}, $lines)));
			$items[] = [
				'id' => (string)$row['id'],
				'dt' => (string)$row['dt'],
				'rate' => (string)($data['rate'] ?? ''),
				'utilPct' => $data['utilPct'] ?? 22,
				'extraPct' => $data['extraPct'] ?? 2.64,
				'rows' => count($lines),
				'vins' => array_slice($vins, 0, 3),
				'sentAt' => (string)$row['sent_at'],
			];
		}

		return ['items' => $items];
	}
}


// ---------- бизнес-процесс ----------

/**
 * Что программа передаёт в БП — параметры шаблона, по одному запуску на строку.
 * Коды и типы задал заказчик; шаблон с такими параметрами он создаёт сам.
 */
final class Bp
{
	/** Код => [название, тип параметра в шаблоне, откуда значение]. */
	public const PARAMS = [
		'PRODUCT_IDS' => ['ID товара', 'Строка', 'product'],
		'RESPONSIBLE' => ['Ответственный', 'Привязка к пользователю', 'user'],
		'VIN' => ['VIN', 'Строка', 'text:vin'],
		'BROKERSKIE' => ['Брокерские', 'Число', 'num:broker'],
		'DATA_VIEZDA' => ['Дата выезда с границы', 'Дата', 'date:dateExit'],
		'DATA_PRIBITIYA' => ['Дата прибытия на пост', 'Дата', 'date:dateArrival'],
		'RASHODI_POGRUZKA' => ['Доп. расходы с погрузкой/выгрузкой', 'Число', 'num:loading'],
		'DOSTAVKA_DO_TAMOZHNI' => ['Доставка до таможни', 'Число', 'num:delivery'],
		'DEKLARACIA' => ['ДТ', 'Строка', 'dt'],
		'JD_V_RUSSIA' => ['ЖД в России', 'Число', 'num:rail'],
		'KONTRAKT' => ['Контракт', 'Строка', 'text:contract'],
		'KURS_PO_DT' => ['Курс по ДТ', 'Число', 'rate'],
		'MODIFIKACIA' => ['Модификация', 'Строка', 'modification'],
		'NDS' => ['НДС', 'Число', 'num:vat'],
		'NDS_OT_MARZHI' => ['НДС от маржи', 'Число', 'num:total'],
		'ORGAN_VEZDA_VIEZDA' => ['Орган въезда/выезда', 'Привязка к спискам документа', 'list:organ'],
		'OTPRAVKA_V_KITAI' => ['Отправка в Китай $Y', 'Число', 'num:amountY'],
		'POSHLINA' => ['Пошлина', 'Число', 'num:duty'],
		'PTS_PSM_BISTROTA' => ['ПТС ПСМ быстрота', 'Число', 'num:pts'],
		'RASTOMOZHENO' => ['Резерв (где растоможили)', 'Привязка к спискам документа', 'list:reserve'],
		'SBORI' => ['Сборы', 'Число', 'num:fees'],
		'SVH' => ['СВХ', 'Число', 'num:svh'],
		'STOIMOST_V_RUB' => ['Стоимость в рублях', 'Число', 'num:cost'],
		'STOYANKA' => ['Стоянка', 'Число', 'num:parking'],
		'SUMMA' => ['Сумма', 'Число', 'num:sum'],
		'UTIL_SBOR' => ['Утиль сбор', 'Число', 'num:util'],
		'UTIL_SBOR_NDS' => ['Утиль сбор с НДС', 'Число', 'num:utilVat'],
	];
	private const FORMULAS = ['cost', 'utilVat', 'sum', 'total'];

	/** Справочник для вкладки «Проверка»: код, название, тип, что передаётся. */
	public static function reference(array $s): array
	{
		// Параметры-списки сверяются с самим шаблоном: что уходит и куда БП это пишет.
		$checks = [];
		if ($s['bp_template_id'] > 0)
		{
			try
			{
				$checks = Diagnostics::listChecks($s, Process::template($s));
			}
			catch (\Throwable $e)
			{
				$checks = [];
			}
		}
		$out = [];
		foreach (self::PARAMS as $code => [$name, $type, $source])
		{
			[$kind, $key] = array_pad(explode(':', $source, 2), 2, '');
			switch ($kind)
			{
				case 'product': $what = 'ID товара, выбранного по VIN; не найден в каталоге — пусто'; break;
				case 'user': $what = 'кто нажал «Отправить»: user_<ID>'; break;
				case 'dt': $what = 'номер ДТ декларации'; break;
				case 'rate': $what = 'курс декларации, 4 знака'; break;
				case 'modification': $what = 'свойство товара ' . $s['modification_code']; break;
				case 'list':
					$list = Lists::options($s, $key);
					$examples = implode(', ', array_map(static function (array $option) {
						return $option['id'] . ' — ' . $option['name'];
					}, array_slice($list['options'], 0, 3)));
					$what = ($list['code'] !== '' ? 'значение поля ' . $list['code'] . ($examples !== '' ? ' (' . $examples . ')' : '')
							: 'значение поля-списка — задайте его в настройках выше')
						. ' в виде, какой ждёт параметр шаблона: у «Привязки к спискам документа» — XML_ID значения, у «Списка» — его ключ.'
						. ' Вписанное вручную уходит, только если такое значение есть в списке, иначе отправка остановится с ошибкой';
					break;
				case 'date': $what = 'дата в формате портала, пусто — пусто'; break;
				case 'num': $what = in_array($key, self::FORMULAS, true) ? 'число по формуле (или вписанное вручную), 2 знака' : 'число, 2 знака; пустая ячейка — пусто'; break;
				default: $what = 'текст ячейки';
			}
			$out[] = ['code' => $code, 'name' => $name, 'type' => $type, 'value' => $what, 'checks' => $checks[$code] ?? []];
		}

		return $out;
	}

	/** Значения параметров для строки. $values — числа и формулы строки (Formula::values). */
	public static function params(string $dt, array $row, array $values, ?array $product, array $user): array
	{
		$out = [];
		foreach (self::PARAMS as $code => [, , $source])
		{
			[$kind, $key] = array_pad(explode(':', $source, 2), 2, '');
			switch ($kind)
			{
				case 'product': $value = $product ? (string)$product['id'] : ''; break;
				case 'user': $value = 'user_' . $user['id']; break;
				case 'dt': $value = $dt; break;
				case 'rate': $value = $values['rate'] !== null ? round((float)$values['rate'], 4) : ''; break;
				case 'modification': $value = $product ? (string)$product['modification'] : ''; break;
				case 'list':
					// ID значения списка (Decls::queue уже перевёл название в ID); вписано вручную — текст.
					$text = trim((string)($row[$key] ?? ''));
					$value = ctype_digit($text) ? (int)$text : $text;
					break;
				case 'date': $value = self::date((string)($row[$key] ?? '')); break;
				case 'num': $value = $values[$key] !== null ? round((float)$values[$key], 2) : ''; break;
				default: $value = trim((string)($row[$key] ?? ''));
			}
			$out[$code] = $value;
		}

		return $out;
	}

	/** «2026-02-25» → дата в формате портала («25.02.2026»). */
	private static function date(string $iso): string
	{
		if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $iso))
		{
			return '';
		}
		try
		{
			return (new \Bitrix\Main\Type\Date($iso, 'Y-m-d'))->toString();
		}
		catch (\Throwable $e)
		{
			return '';
		}
	}
}

/**
 * Запуск шаблона БП без исходной карточки — как в «Перегоне»: программа не создаёт
 * элементы CRM, а только «толкает» БП с входными параметрами. Если в шаблоне есть
 * ровно один блок «Создать элемент» своего смарт-процесса, после него БП переключается
 * на созданный элемент. Инициатор — сотрудник, нажавший «Отправить».
 */
final class Process
{
	public static function template(array $s): array
	{
		Portal::need('bizproc');
		if ($s['bp_template_id'] <= 0)
		{
			throw new AppError('Не указан шаблон бизнес-процесса — владелец программы указывает его ID во вкладке «Проверка»');
		}
		$row = \CBPWorkflowTemplateLoader::GetList(
			[],
			['ID' => $s['bp_template_id']],
			false,
			false,
			['ID', 'NAME', 'MODULE_ID', 'ENTITY', 'DOCUMENT_TYPE', 'PARAMETERS', 'ACTIVE', 'TEMPLATE', 'MODIFIED']
		)->Fetch();
		if (!$row)
		{
			throw new AppError('Шаблон бизнес-процесса #' . $s['bp_template_id'] . ' не найден на портале');
		}
		// Тип документа приходит то тройкой [модуль, класс, тип], то одной строкой.
		$type = $row['DOCUMENT_TYPE'] ?? '';
		if (is_array($type))
		{
			$type = array_values($type);
			$row['MODULE_ID'] = Text::scalar($row['MODULE_ID'] ?? '') ?: Text::scalar($type[0] ?? '');
			$row['ENTITY'] = Text::scalar($row['ENTITY'] ?? '') ?: Text::scalar($type[1] ?? '');
			$type = $type[2] ?? '';
		}
		$row['DOCUMENT_TYPE'] = Text::scalar($type);
		$row['MODULE_ID'] = Text::scalar($row['MODULE_ID'] ?? '');
		$row['ENTITY'] = Text::scalar($row['ENTITY'] ?? '');
		$row['PARAMETERS'] = self::decode($row['PARAMETERS'] ?? null);
		$row['TEMPLATE'] = self::decode($row['TEMPLATE'] ?? null);
		$modified = $row['MODIFIED'] ?? '';
		$row['MODIFIED'] = is_object($modified) && method_exists($modified, 'toString') ? (string)$modified->toString() : Text::scalar($modified);

		return $row;
	}

	/** Шаблон, который можно запускать: из CRM, включён, ядро умеет запуск без карточки. */
	public static function forLaunch(array $s): array
	{
		$template = self::template($s);
		if ($template['MODULE_ID'] !== 'crm')
		{
			throw new AppError('Шаблон БП #' . $template['ID'] . ' не из CRM — нужен шаблон смарт-процесса');
		}
		if (($template['ACTIVE'] ?? 'Y') === 'N')
		{
			throw new AppError('Шаблон БП #' . $template['ID'] . ' выключен');
		}
		if (!defined('CBPDocument::PARAM_DOCUMENT_TYPE'))
		{
			throw new AppError('Эта версия ядра Битрикса не умеет запускать БП без карточки — обновите модуль «Бизнес-процессы»');
		}
		Portal::need('crm');

		return $template;
	}

	/** Значения параметров, сверенные с шаблоном: БП не должен стартовать вслепую. */
	public static function parameters(array $template, array $values): array
	{
		$declared = $template['PARAMETERS'];
		$missing = array_values(array_diff(array_keys($values), array_keys($declared)));
		if ($missing)
		{
			throw new AppError('В шаблоне БП #' . $template['ID'] . ' нет параметров: ' . implode(', ', $missing)
				. ' — добавьте их в шаблон с такими же кодами (список — во вкладке «Проверка»)');
		}
		$out = [];
		foreach ($values as $code => $value)
		{
			$value = self::listValue($template, $code, $value);
			$out[$code] = Text::flag($declared[$code]['Multiple'] ?? false) ? ($value === '' ? [] : [$value]) : $value;
		}
		// Остальное — как форма запуска на портале: значение по умолчанию, а
		// обязательный параметр без него не даст запуститься вовсе.
		foreach ($declared as $code => $parameter)
		{
			if (array_key_exists($code, $out))
			{
				continue;
			}
			$default = $parameter['Default'] ?? null;
			if ($default !== null && $default !== '' && $default !== [])
			{
				$out[$code] = $default;
			}
			elseif (Text::flag($parameter['Required'] ?? false))
			{
				throw new AppError('Обязательный параметр БП ' . $code . ' «' . Text::scalar($parameter['Name'] ?? $code)
					. '» программа не заполняет — снимите обязательность или задайте значение по умолчанию');
			}
		}

		return $out;
	}

	private static array $documentFields = [];
	private static array $enums = [];

	/**
	 * Значения параметра-списка шаблона: ключ => название. «Список» — из самого параметра,
	 * «Привязка к спискам документа» (internalselect) — из поля документа, к которому он привязан.
	 * null — параметр в шаблоне не список.
	 */
	public static function listOptions(array $template, string $code): ?array
	{
		$parameter = $template['PARAMETERS'][$code] ?? null;
		$type = is_array($parameter) ? Text::scalar($parameter['Type'] ?? '') : '';
		if ($type === 'select')
		{
			return is_array($parameter['Options'] ?? null) ? $parameter['Options'] : [];
		}
		if ($type !== 'internalselect')
		{
			return null;
		}
		$options = self::documentFields($template)[self::listField($template, $code)]['Options'] ?? null;

		return is_array($options) ? $options : [];
	}

	/** Поле документа, к которому привязан параметр «Привязка к спискам документа», или ''. */
	public static function listField(array $template, string $code): string
	{
		$field = $template['PARAMETERS'][$code]['Options'] ?? '';
		if (is_array($field))
		{
			$field = reset($field);
		}

		return trim(Text::scalar($field));
	}

	/**
	 * Ключ значения для параметра-списка. В CRM значения поля-списка в БП — это XML_ID, а не ID:
	 * ID 2494 → XML_ID этого значения; название («10504080, Г.ЧЕЛЯБИНСК») → его ключ.
	 * null — в списке параметра такого значения нет.
	 */
	public static function listKey(array $options, $value): ?string
	{
		$text = trim(Text::scalar($value));
		$keys = [$text];
		$names = [$text];
		if (ctype_digit($text) && ($enum = self::enum((int)$text)))
		{
			$keys[] = $enum['xml'];
			$names[] = $enum['name'];
		}
		foreach ($keys as $wanted)
		{
			foreach ($options as $key => $name)
			{
				if ($wanted !== '' && ((string)$key === $wanted || html_entity_decode((string)$key, ENT_QUOTES) === $wanted))
				{
					return (string)$key;
				}
			}
		}
		foreach ($names as $wanted)
		{
			foreach ($options as $key => $name)
			{
				if ($wanted !== '' && self::plain(Text::scalar($name)) === self::plain($wanted))
				{
					return (string)$key;
				}
			}
		}

		return null;
	}

	/** Название значения списка по ID («2494» → «10504080, Г.ЧЕЛЯБИНСК»), иначе как есть. */
	public static function listName($value): string
	{
		$text = trim(Text::scalar($value));
		$enum = ctype_digit($text) ? self::enum((int)$text) : null;

		return $enum ? $enum['name'] . ' (ID ' . $text . ')' : $text;
	}

	/** Колонка-список → ключ, который ждёт шаблон. Не нашлось — ошибка: иначе поле в БП останется пустым. */
	private static function listValue(array $template, string $code, $value)
	{
		$source = Bp::PARAMS[$code][2] ?? '';
		if (strpos($source, 'list:') !== 0 || trim(Text::scalar($value)) === '')
		{
			return $value;
		}
		$options = self::listOptions($template, $code);
		if ($options === null)
		{
			return $value;
		}
		$label = Bp::PARAMS[$code][0];
		$where = Text::scalar($template['PARAMETERS'][$code]['Type'] ?? '') === 'internalselect'
			? 'поля ' . self::listField($template, $code) . ', к которому привязан параметр ' . $code
			: 'параметра ' . $code;
		$text = trim(Text::scalar($value));
		$enum = ctype_digit($text) ? self::enum((int)$text) : null;
		if (!$options && $enum && $enum['xml'] !== '')
		{
			// Список шаблона не прочитался — в CRM ключ значения поля-списка это XML_ID.
			return $enum['xml'];
		}
		if (!$options)
		{
			throw new AppError('«' . $label . '»: в шаблоне БП #' . $template['ID'] . ' не прочитаны значения ' . $where
				. ' — проверьте параметр во вкладке «Проверка»');
		}
		$key = self::listKey($options, $value);
		if ($key === null)
		{
			throw new AppError('«' . $label . '»: значения «' . self::listName($value) . '» нет в списке ' . $where
				. ' в шаблоне БП — выберите значение из списка (или добавьте его в поле-список на портале)');
		}

		return $key;
	}

	/** Поля документа шаблона — как их видит БП (у полей-списков — Options: ключ => название). */
	private static function documentFields(array $template): array
	{
		$id = (string)$template['ID'];
		if (!isset(self::$documentFields[$id]))
		{
			try
			{
				$runtime = \CBPRuntime::GetRuntime();
				$runtime->StartRuntime();
				$fields = $runtime->GetService('DocumentService')
					->GetDocumentFields([$template['MODULE_ID'], $template['ENTITY'], $template['DOCUMENT_TYPE']]);
			}
			catch (\Throwable $e)
			{
				error_log('gross.declarations document fields: ' . $e);
				$fields = [];
			}
			self::$documentFields[$id] = is_array($fields) ? $fields : [];
		}

		return self::$documentFields[$id];
	}

	/** Значение поля-списка по ID: ['xml' => XML_ID, 'name' => название] или null. */
	private static function enum(int $id): ?array
	{
		if (!array_key_exists($id, self::$enums))
		{
			try
			{
				$row = \CUserFieldEnum::GetList([], ['ID' => $id])->Fetch();
			}
			catch (\Throwable $e)
			{
				$row = false;
			}
			self::$enums[$id] = is_array($row)
				? ['xml' => Text::scalar($row['XML_ID'] ?? ''), 'name' => Text::clean(Text::scalar($row['VALUE'] ?? ''))]
				: null;
		}

		return self::$enums[$id];
	}

	/** Для сравнения названий: без кавычек, регистра и лишних пробелов. */
	private static function plain(string $text): string
	{
		$text = html_entity_decode($text, ENT_QUOTES | ENT_HTML5, 'UTF-8');

		return mb_strtolower(Text::clean(str_replace(['"', "'", '«', '»', '“', '”', '„'], '', $text)));
	}

	/** Один запуск с параметрами, без исходной карточки. error — БП не запустился, warning — запустился, но в журнале БП ошибка. */
	public static function start(array $template, array $parameters, int $userId): array
	{
		$type = [$template['MODULE_ID'], $template['ENTITY'], $template['DOCUMENT_TYPE']];
		// TargetUser — это CBPDocument::PARAM_TAGRET_USER (опечатка в имени константы — Битрикса).
		$parameters['TargetUser'] = 'user_' . $userId;
		// Иначе CBPWorkflow::initialize пытается определить тип через несуществующий элемент 0.
		$parameters[\CBPDocument::PARAM_DOCUMENT_TYPE] = $type;
		$parameters[\CBPDocument::PARAM_USE_FORCED_TRACKING] = true;
		$creator = self::creator($template);
		$workflow = \CBPRuntime::GetRuntime()->CreateWorkflow((int)$template['ID'], [$type[0], $type[1], $type[2] . '_0'], $parameters);
		$root = $workflow->GetRootActivity();
		try
		{
			$permissions = $root->Permission;
		}
		catch (\Throwable $e)
		{
			$permissions = false;
		}
		// Карточки нет — назначать права некому. Если БП её создаст, права вернутся (CreatedItemBinding).
		$root->SetProperties(['Permission' => false]);
		$activity = $creator !== '' ? $workflow->GetActivityByName($creator) : null;
		$binding = $activity ? new CreatedItemBinding($type, self::entityTypeId($template), $permissions) : null;
		if ($binding)
		{
			$activity->AddStatusChangeHandler(\CBPActivity::ClosedEvent, $binding);
		}
		$error = '';
		try
		{
			$workflow->Start();
		}
		catch (\Throwable $e)
		{
			$error = $e->getMessage();
			if (!$e instanceof AppError)
			{
				error_log('gross.declarations bp start: ' . $e);
			}
		}
		finally
		{
			if ($binding)
			{
				$activity->RemoveStatusChangeHandler(\CBPActivity::ClosedEvent, $binding);
			}
		}
		$workflowId = (string)$workflow->GetInstanceId();
		$warning = $error === '' ? self::trackedError($workflowId) : '';
		if ($binding && $binding->problem !== '')
		{
			$warning = trim($binding->problem . ($warning !== '' ? '; ' . $warning : ''));
		}

		return ['workflowId' => $workflowId, 'itemId' => $binding ? $binding->itemId : 0, 'error' => $error, 'warning' => $warning];
	}

	/** Смарт-процесс шаблона: DYNAMIC_1036 → 1036, иначе 0. */
	public static function entityTypeId(array $template): int
	{
		return preg_match('/^DYNAMIC_(\d+)$/', $template['DOCUMENT_TYPE'], $m) ? (int)$m[1] : 0;
	}

	/** Имя единственного блока «Создать элемент» своего смарт-процесса или ''. */
	public static function creator(array $template): string
	{
		$node = self::creatorNode($template);

		return $node ? (string)$node['Name'] : '';
	}

	/**
	 * Что блок «Создать элемент» пишет в поля элемента: поле => значение («{=Template:RASTOMOZHENO}»).
	 * null — блока нет или их несколько.
	 */
	public static function creatorFields(array $template): ?array
	{
		$node = self::creatorNode($template);
		if (!$node)
		{
			return null;
		}
		$prefix = self::entityTypeId($template) . '_';
		$out = [];
		$fields = $node['Properties']['DynamicEntitiesFields'] ?? [];
		foreach (is_array($fields) ? $fields : [] as $key => $value)
		{
			if (strpos((string)$key, $prefix) === 0)
			{
				$out[substr((string)$key, strlen($prefix))] = $value;
			}
		}

		return $out;
	}

	/**
	 * Параметры-списки, которые блок «Создать элемент» не пишет в своё поле: [код => что там стоит].
	 * Значение уходит в БП, но в элементе это поле остаётся пустым.
	 */
	public static function listGaps(array $s, array $template): array
	{
		$fields = self::creatorFields($template);
		if ($fields === null)
		{
			return [];
		}
		$out = [];
		foreach (Bp::PARAMS as $code => [, , $source])
		{
			if (strpos($source, 'list:') !== 0 || !isset($template['PARAMETERS'][$code]))
			{
				continue;
			}
			$field = Lists::options($s, substr($source, 5))['field']['name'] ?? '';
			if ($field === '')
			{
				$field = self::listField($template, $code);
			}
			if ($field === '')
			{
				continue;
			}
			$value = $fields[$field] ?? '';
			$text = is_array($value) ? implode(', ', array_map([Text::class, 'scalar'], $value)) : Text::scalar($value);
			if (strpos($text, 'Template:' . $code . '}') === false && strpos($text, 'Template:' . $code . ' ') === false)
			{
				$out[$code] = ['field' => $field, 'value' => $text];
			}
		}

		return $out;
	}

	/** Где в сохранённом шаблоне стоит параметр: ["«Создать элемент»: DynamicEntitiesFields.1036_UF_CRM_…"]. */
	public static function usages(array $template, string $code): array
	{
		$needle = 'Template:' . $code;
		$out = [];
		$scan = static function ($value, string $path, array &$paths) use (&$scan, $needle): void {
			if (is_array($value))
			{
				foreach ($value as $key => $item)
				{
					$scan($item, $path === '' ? (string)$key : $path . '.' . $key, $paths);
				}
			}
			elseif (is_string($value) && preg_match('/' . preg_quote($needle, '/') . '(?![A-Z0-9_])/i', $value))
			{
				$paths[] = $path;
			}
		};
		$walk = static function (array $nodes) use (&$walk, &$out, $scan): void {
			foreach ($nodes as $node)
			{
				if (!is_array($node))
				{
					continue;
				}
				$paths = [];
				$scan(is_array($node['Properties'] ?? null) ? $node['Properties'] : [], '', $paths);
				if ($paths)
				{
					$title = Text::scalar($node['Properties']['Title'] ?? '');
					$out[] = '«' . ($title !== '' ? $title : Text::scalar($node['Type'] ?? '')) . '»'
						. (($node['Activated'] ?? 'Y') === 'N' ? ' (блок выключен)' : '') . ' — ' . implode(', ', $paths);
				}
				$walk(is_array($node['Children'] ?? null) ? $node['Children'] : []);
			}
		};
		$walk(is_array($template['TEMPLATE'] ?? null) ? $template['TEMPLATE'] : []);

		return $out;
	}

	/** Единственный включённый блок «Создать элемент» своего смарт-процесса или null. */
	private static function creatorNode(array $template): ?array
	{
		$entityTypeId = self::entityTypeId($template);
		if ($entityTypeId <= 0)
		{
			return null;
		}
		$found = [];
		$walk = static function (array $nodes) use (&$walk, &$found, $entityTypeId): void {
			foreach ($nodes as $node)
			{
				if (!is_array($node) || ($node['Activated'] ?? 'Y') === 'N')
				{
					continue;
				}
				if (($node['Type'] ?? '') === 'CrmCreateDynamicActivity'
					&& (int)($node['Properties']['DynamicTypeId'] ?? 0) === $entityTypeId)
				{
					$found[] = $node;
				}
				$walk(is_array($node['Children'] ?? null) ? $node['Children'] : []);
			}
		};
		$walk($template['TEMPLATE']);

		return count($found) === 1 ? $found[0] : null;
	}

	/** Первая ошибка из журнала только что запущенного БП. */
	private static function trackedError(string $workflowId): string
	{
		if ($workflowId === '')
		{
			return '';
		}
		try
		{
			$rows = \CBPTrackingService::GetList(['ID' => 'DESC'], ['WORKFLOW_ID' => $workflowId], false, ['nTopCount' => 50]);
			while ($row = $rows->Fetch())
			{
				if (in_array((int)$row['TYPE'], [\CBPTrackingType::Error, \CBPTrackingType::FaultActivity], true))
				{
					return 'в журнале БП ' . $workflowId . ': '
						. trim(Text::scalar($row['ACTION_TITLE'] ?? '') . ': ' . Text::scalar($row['ACTION_NOTE'] ?? ''), ': ');
				}
			}
		}
		catch (\Throwable $e)
		{
			// Журнал БП недоступен — запуск от этого не хуже.
		}

		return '';
	}

	private static function decode($value): array
	{
		if (is_string($value) && $value !== '')
		{
			$data = @unserialize($value, ['allowed_classes' => false]);
			$value = is_array($data) ? $data : json_decode($value, true);
		}

		return is_array($value) ? $value : [];
	}
}

/** Переход БП к элементу, который создал он сам, — до следующих действий шаблона (как в «Перегоне»). */
final class CreatedItemBinding
{
	public int $itemId = 0;
	public string $problem = '';
	private array $type;
	private int $entityTypeId;
	private $permissions;

	public function __construct(array $type, int $entityTypeId, $permissions)
	{
		$this->type = $type;
		$this->entityTypeId = $entityTypeId;
		$this->permissions = $permissions;
	}

	public function OnEvent(\CBPActivity $sender, $eventParameters = []): void
	{
		$sender->RemoveStatusChangeHandler(\CBPActivity::ClosedEvent, $this);
		try
		{
			$id = (int)$sender->ItemId;
		}
		catch (\Throwable $e)
		{
			$id = 0;
		}
		if ($id <= 0)
		{
			return;
		}
		$factory = Container::getInstance()->getFactory($this->entityTypeId);
		if (!$factory || !$factory->getItem($id))
		{
			$this->problem = 'БП вернул элемент #' . $id . ', но он не найден';

			return;
		}
		$this->itemId = $id;
		$workflow = $sender->workflow;
		$documentId = $this->type[2] . '_' . $id;
		$result = \Bitrix\Bizproc\Workflow\Entity\WorkflowStateTable::update($workflow->GetInstanceId(), ['DOCUMENT_ID' => $documentId]);
		if (!$result->isSuccess())
		{
			$this->problem = 'БП не привязан к созданному элементу #' . $id . ': ' . implode('; ', $result->getErrorMessages());

			return;
		}
		$root = $workflow->GetRootActivity();
		$root->SetDocumentId([$this->type[0], $this->type[1], $documentId]);
		$root->SetProperties(['Permission' => $this->permissions]);
		if ($this->permissions !== false)
		{
			$workflow->GetService('StateService')->SetStatePermissions($workflow->GetInstanceId(), $this->permissions);
		}
	}
}

/**
 * Журнал действий. Браузер присылает записи пачками; кто и когда — ставит сервер
 * по сессии портала. У записи свой id: повтор после обрыва связи дубля не даёт.
 */
final class Journal
{
	private const BATCH = 200;
	private const SHOW = 5000;

	public static function write($entries, array $user): void
	{
		$clean = [];
		foreach (array_slice(is_array($entries) ? $entries : [], 0, self::BATCH) as $entry)
		{
			$id = is_array($entry) ? Text::scalar($entry['id'] ?? '') : '';
			if (!preg_match('/^[a-f0-9]{32}$/', $id))
			{
				continue;
			}
			$clean[$id] = [
				'act' => Text::short($entry['action'] ?? '', 64),
				'data' => [
					'text' => Text::short($entry['text'] ?? '', 1000),
					'dt' => Text::short($entry['dt'] ?? '', 100),
					'vin' => Text::short($entry['vin'] ?? '', 500),
					'field' => Text::short($entry['field'] ?? '', 255),
					'from' => Text::short($entry['from'] ?? '', 500),
					'to' => Text::short($entry['to'] ?? '', 500),
					'change' => !empty($entry['change']),
					'clientTs' => Text::short($entry['ts'] ?? '', 40),
					'ip' => Text::short($_SERVER['REMOTE_ADDR'] ?? '', 64),
				],
			];
		}
		if (!$clean)
		{
			return;
		}
		$known = array_column(Db::rows('SELECT id FROM ' . Db::LOG . ' WHERE id IN ('
			. implode(', ', array_map([Db::class, 'str'], array_map('strval', array_keys($clean)))) . ')'), 'id');
		$ts = (int)round(microtime(true) * 1000);
		foreach ($clean as $id => $entry)
		{
			if (in_array((string)$id, $known, true))
			{
				continue;
			}
			Db::exec('INSERT INTO ' . Db::LOG . ' (id, ts, user_id, user_name, act, data) VALUES ('
				. Db::str((string)$id) . ', ' . $ts++ . ', ' . $user['id'] . ', ' . Db::str(mb_substr($user['name'], 0, 255)) . ', '
				. Db::str($entry['act']) . ', ' . Db::str(Db::json($entry['data'])) . ')');
		}
	}

	public static function latest(): array
	{
		$out = [];
		foreach (Db::rows('SELECT * FROM ' . Db::LOG . ' ORDER BY ts DESC LIMIT ' . self::SHOW) as $row)
		{
			$data = json_decode((string)$row['data'], true) ?: [];
			$out[] = [
				'id' => (string)$row['id'],
				'ts' => gmdate('Y-m-d\TH:i:s\Z', (int)floor((int)$row['ts'] / 1000)),
				'user' => ['id' => (int)$row['user_id'], 'name' => (string)$row['user_name']],
				'action' => (string)$row['act'],
				'text' => $data['text'] ?? '',
				'dt' => $data['dt'] ?? '',
				'vin' => $data['vin'] ?? '',
				'field' => $data['field'] ?? '',
				'from' => $data['from'] ?? '',
				'to' => $data['to'] ?? '',
				'change' => !empty($data['change']),
			];
		}

		return $out;
	}

	public static function count(): int
	{
		$rows = Db::rows('SELECT COUNT(*) AS cnt FROM ' . Db::LOG);

		return (int)($rows[0]['cnt'] ?? 0);
	}
}


// ---------- проверка ----------

/** Что программа видит на портале. Падение одного блока не прячет ответы остальных. */
final class Diagnostics
{
	public static function run(array $s): array
	{
		$blocks = ['portal' => 'Портал и база', 'access' => 'Владелец и доступ', 'catalog' => 'Каталог товаров',
			'reserve' => 'Список «Резерв (где растоможили)»', 'organ' => 'Список «Орган въезда/выезда»',
			'process' => 'Бизнес-процесс («Отправить»)'];
		$out = [];
		foreach ($blocks as $method => $title)
		{
			$report = new Report();
			try
			{
				self::$method($s, $report);
			}
			catch (\Throwable $e)
			{
				$report->error($e->getMessage());
			}
			$out[] = ['title' => $title, 'items' => $report->items];
		}

		return $out;
	}

	private static function portal(array $s, Report $r): void
	{
		foreach (['iblock' => 'каталог', 'catalog' => 'торговый каталог'] as $module => $what)
		{
			$r->check(Loader::includeModule($module), 'Модуль «' . $module . '» (' . $what . ')',
				'Модуль «' . $module . '» не установлен — ' . $what . ' недоступен');
		}
		$r->info('Данные портала программа берёт напрямую через его ядро — вебхук не нужен');
		$connection = Application::getConnection();
		$r->info('База портала: ' . $connection->getType());
		Db::ensure();
		$r->check($connection->isTableExists(Db::DECL), 'Таблица деклараций ' . Db::DECL . ' на месте', 'Нет таблицы ' . Db::DECL);
		$r->check($connection->isTableExists(Db::LOG), 'Таблица журнала ' . Db::LOG . ' на месте', 'Нет таблицы ' . Db::LOG);
		$counts = Decls::counts();
		$r->info('Деклараций: черновиков ' . $counts['draft'] . ', отправленных ' . $counts['sent']
			. ($counts['sending'] ? ', с незаконченной отправкой ' . $counts['sending'] : '') . '. Записей в журнале: ' . Journal::count());
	}

	private static function access(array $s, Report $r): void
	{
		$owner = Access::ownerId();
		if ($owner <= 0)
		{
			$r->error('Владелец не назначен — откройте программу администратором портала');

			return;
		}
		$card = Users::describe([$owner])[0];
		$r->check($card['active'], 'Владелец — ' . $card['name'] . ' (установил программу)',
			'Владелец ' . $card['name'] . ' уволен или удалён — первый администратор, открывший программу, станет владельцем');
		$r->info('Сотрудников с доступом: ' . count(Access::allowed()) . '. Администраторы портала сами доступа не получают');
	}

	private static function catalog(array $s, Report $r): void
	{
		$iblocks = Catalog::iblocks($s);
		$r->info($s['catalog_iblock_ids'] ? 'Каталоги — из настроек ниже' : 'Каталоги подобраны сами: все каталоги товаров портала, без торговых предложений');
		foreach ($iblocks as $id => $name)
		{
			$count = (int)\CIBlockElement::GetList([], ['IBLOCK_ID' => $id, 'ACTIVE' => 'Y', 'CHECK_PERMISSIONS' => 'N'], []);
			$title = 'Инфоблок #' . $id . ' «' . $name . '»: активных товаров ' . $count . ', все папки';
			$count > 0 ? $r->ok($title) : $r->warn($title);
			$vin = Catalog::vinFields($s, $id);
			$model = Catalog::modelFields($s, $id);
			$titles = static function (array $fields) use ($id) {
				return $fields ? implode(', ', array_map(static function ($field) use ($id) {
					return Fields::title($id, $field);
				}, $fields)) : '';
			};
			if ($vin)
			{
				$r->info('#' . $id . ': VIN берётся из ' . $titles($vin));
			}
			else
			{
				$r->warn('#' . $id . ': свойство с VIN не найдено — товары ищутся по названию, в ячейку VIN встаёт название');
			}
			$r->info('#' . $id . ': модель для поиска и подсказок — ' . ($model ? $titles($model) : 'свойство не найдено, ищется по названию'));
			$modification = Catalog::modificationProperty($s, $id);
			if ($modification !== null)
			{
				$text = '#' . $id . ': «Марка модель» берётся из свойства «' . $modification['name'] . '» ['
					. ($modification['code'] !== '' ? $modification['code'] : 'без кода') . '] — '
					. $modification['field'] . ($modification['type'] === 'L' ? ', список' : '');
				if ($modification['byName'])
				{
					$r->warn($text . '. Свойства с кодом ' . $s['modification_code'] . ' нет — взято по названию; если это не то, впишите код в настройках ниже');
				}
				else
				{
					$r->ok($text);
				}
				$filled = (int)\CIBlockElement::GetList([], ['IBLOCK_ID' => $id, 'ACTIVE' => 'Y', 'CHECK_PERMISSIONS' => 'N',
					'!' . $modification['field'] => false], []);
				$r->info('#' . $id . ': «Модификация» заполнена у ' . $filled . ' активных товаров — у остальных «Марка модель» будет пустой');
			}
			else
			{
				$r->warn('#' . $id . ': свойства ' . $s['modification_code'] . ' нет — у товаров этого каталога «Марка модель» будет пустой');
			}
			$declaration = Catalog::declarationProperty($s, $id);
			if ($declaration !== null)
			{
				$used = (int)\CIBlockElement::GetList([], ['IBLOCK_ID' => $id, 'CHECK_PERMISSIONS' => 'N',
					'!' . $declaration['field'] => false], []);
				$r->ok('#' . $id . ': повтор VIN проверяется по свойству «' . $declaration['name'] . '» [' . $declaration['code'] . '] — '
					. $declaration['field'] . '. Заполнено у ' . $used . ' товаров: их VIN уже были в декларации, повторно не отправляются');
			}
			else
			{
				$r->warn('#' . $id . ': свойства ' . $s['declaration_code'] . ' нет — был ли VIN уже в декларации, по товару не проверяется');
			}
		}
	}

	private static function reserve(array $s, Report $r): void
	{
		self::listReport($s, 'reserve', $r);
	}

	private static function organ(array $s, Report $r): void
	{
		self::listReport($s, 'organ', $r);
	}

	private static function listReport(array $s, string $column, Report $r): void
	{
		$info = Lists::options($s, $column);
		$field = $info['field'];
		if ($info['error'] !== '')
		{
			$r->warn($info['error']);
		}
		else
		{
			$r->ok('Поле ' . $field['name'] . ' (ID ' . $field['id'] . ')' . ($field['label'] !== '' ? ' «' . $field['label'] . '»' : '')
				. ' — список, сущность ' . $field['entity']);
		}
		if ($info['options'])
		{
			$r->info('Значения в колонке: ' . implode(', ', array_map(static function (array $option) {
				return $option['name'] . ' (' . $option['id'] . ')';
			}, $info['options'])) . '. Что из них уходит в БП — в блоке «Отправка в бизнес-процесс»');
		}
		$r->info('При загрузке XML значение подбирается из списка; не подобралось — в этой строке колонку можно вписать вручную,'
			. ' но в БП оно уйдёт, только если такое значение есть в списке параметра шаблона');
	}

	private static function process(array $s, Report $r): void
	{
		foreach (['crm' => 'смарт-процессы', 'bizproc' => 'бизнес-процессы'] as $module => $what)
		{
			$r->check(Loader::includeModule($module), 'Модуль «' . $module . '» (' . $what . ')',
				'Модуль «' . $module . '» не установлен — ' . $what . ' недоступны');
		}
		$r->check(defined('CBPDocument::PARAM_DOCUMENT_TYPE'), 'Ядро умеет запускать БП без карточки, как в «Перегоне»',
			'Ядро не умеет запускать БП без карточки — обновите модуль «Бизнес-процессы»');
		if ($s['bp_template_id'] <= 0)
		{
			$r->warn('Шаблон БП не указан — впишите его ID в блоке «Отправка в бизнес-процесс» ниже. Без него «Отправить» не сработает');

			return;
		}
		$template = Process::template($s);
		$entityTypeId = Process::entityTypeId($template);
		$where = $template['MODULE_ID'] . ', ' . $template['DOCUMENT_TYPE'];
		if ($entityTypeId > 0 && Loader::includeModule('crm'))
		{
			$factory = Container::getInstance()->getFactory($entityTypeId);
			$where = $factory ? 'смарт-процесс «' . $factory->getEntityDescription() . '» (entityTypeId ' . $entityTypeId . ')' : $where;
		}
		$r->ok('Шаблон БП #' . $template['ID'] . ' «' . Text::clean(Text::scalar($template['NAME'])) . '» — ' . $where);
		if ($template['MODULE_ID'] !== 'crm')
		{
			$r->error('Шаблон не из CRM — нужен шаблон смарт-процесса');
		}
		if (($template['ACTIVE'] ?? 'Y') === 'N')
		{
			$r->error('Шаблон выключен — включите его в списке шаблонов');
		}
		foreach (Lists::COLUMNS as $column => $info)
		{
			$listType = Lists::entityTypeId($s, $column);
			if ($listType > 0 && $entityTypeId > 0 && $listType !== $entityTypeId)
			{
				$r->warn('Поле «' . $info['label'] . '» ' . $s[$info['setting']] . ' — из другого смарт-процесса (entityTypeId ' . $listType . '), чем шаблон');
			}
		}
		$declared = $template['PARAMETERS'];
		$missing = array_values(array_diff(array_keys(Bp::PARAMS), array_keys($declared)));
		if ($missing)
		{
			$r->error('В шаблоне нет параметров (' . count($missing) . ' из ' . count(Bp::PARAMS) . '): ' . implode(', ', $missing));
		}
		else
		{
			$r->ok('Все ' . count(Bp::PARAMS) . ' параметров есть в шаблоне');
		}
		self::listParams($s, $template, $r);
		foreach ($declared as $code => $parameter)
		{
			if (!isset(Bp::PARAMS[$code]) && Text::flag($parameter['Required'] ?? false)
				&& in_array($parameter['Default'] ?? null, [null, '', []], true))
			{
				$r->error('Обязательный параметр ' . $code . ' «' . Text::scalar($parameter['Name'] ?? $code)
					. '» программа не заполняет — снимите обязательность или задайте значение по умолчанию');
			}
		}
		$r->info(Process::creator($template) !== ''
			? 'В шаблоне есть блок «Создать элемент» этого смарт-процесса — после него БП работает с созданным элементом'
			: 'Блока «Создать элемент» этого смарт-процесса в шаблоне нет (или их несколько) — БП работает без карточки');
	}

	/** Параметры-списки шаблона: какой ключ уйдёт в БП за каждое значение колонки. */
	private static function listParams(array $s, array $template, Report $r): void
	{
		foreach (self::listChecks($s, $template) as $code => $checks)
		{
			foreach ($checks as $check)
			{
				$r->{$check['status']}($code . ' «' . Bp::PARAMS[$code][0] . '»: ' . $check['text']);
			}
		}
	}

	/**
	 * Проверка параметров-списков по шаблону: код => [{status: ok|warn|error, text}].
	 * Видна и в отчёте «Проверки», и в строке параметра в таблице «Что передаётся в БП».
	 */
	public static function listChecks(array $s, array $template): array
	{
		$gaps = Process::listGaps($s, $template);
		$creator = Process::creatorFields($template);
		$out = [];
		foreach (Bp::PARAMS as $code => [$label, , $source])
		{
			if (strpos($source, 'list:') !== 0)
			{
				continue;
			}
			$checks = [];
			$add = static function (string $status, string $text) use (&$checks): void {
				$checks[] = ['status' => $status, 'text' => $text];
			};
			if (!isset($template['PARAMETERS'][$code]))
			{
				$add('error', 'параметра нет в шаблоне БП #' . $template['ID']);
				$out[$code] = $checks;
				continue;
			}
			$column = substr($source, 5);
			$listField = Lists::options($s, $column)['field'];
			$type = Text::scalar($template['PARAMETERS'][$code]['Type'] ?? '');
			$options = Process::listOptions($template, $code);
			$field = Process::listField($template, $code);
			$where = $type === 'internalselect' ? '«Привязка к спискам документа» → поле ' . ($field !== '' ? $field : '(не выбрано)') : '«Список»';

			if (isset($gaps[$code]))
			{
				$used = Process::usages($template, $code);
				$add('error', 'в сохранённом шаблоне #' . $template['ID'] . ' «' . Text::clean(Text::scalar($template['NAME'] ?? '')) . '»'
					. (Text::scalar($template['MODIFIED'] ?? '') !== '' ? ' (сохранён ' . Text::scalar($template['MODIFIED']) . ')' : '')
					. ' в блоке «Создать элемент» поле ' . $gaps[$code]['field'] . ' НЕ берётся из этого параметра — '
					. ($gaps[$code]['value'] !== '' ? 'там стоит «' . $gaps[$code]['value'] . '»' : 'там пусто') . '. '
					. ($used ? 'Параметр стоит в другом месте: ' . implode('; ', $used) . '.'
						: 'Параметр нигде в шаблоне не используется — изменения не сохранены (кнопка «Сохранить» внизу шаблона) или правился другой шаблон.'));
			}
			elseif ($creator !== null)
			{
				$target = $listField['name'] ?? $field;
				$value = $creator[$target] ?? '';
				$add('ok', 'блок «Создать элемент»: поле ' . $target . ' = '
					. (is_array($value) ? implode(', ', array_map([Text::class, 'scalar'], $value)) : Text::scalar($value)));
			}
			else
			{
				$add('warn', 'блока «Создать элемент» этого смарт-процесса в шаблоне нет (или их несколько) — куда БП пишет значение, программа не видит');
			}

			if ($options === null)
			{
				$add('warn', 'в шаблоне тип «' . $type . '», не список — уйдёт ID значения числом. Поле-список из него не заполнится;'
					. ' сделайте параметр «Привязка к спискам документа» к полю ' . ($listField['name'] ?? ''));
				$out[$code] = $checks;
				continue;
			}
			if ($type === 'internalselect' && $listField !== null && $field !== $listField['name'])
			{
				$add('error', 'параметр привязан к полю ' . ($field !== '' ? $field : '(не выбрано)') . ', а должен — к ' . $listField['name']
					. '. Исправьте в настройках параметра шаблона');
			}
			if (!$options)
			{
				$add('warn', $where . ' — значения списка не прочитаны; уйдёт XML_ID значения');
				$out[$code] = $checks;
				continue;
			}
			$sent = [];
			$lost = [];
			foreach (Lists::options($s, $column)['options'] as $option)
			{
				$key = Process::listKey($options, $option['id']);
				if ($key === null)
				{
					$lost[] = $option['name'];
				}
				else
				{
					$sent[] = $option['name'] . ' → «' . $key . '»';
				}
			}
			if ($lost)
			{
				$add('error', $where . ' — в его списке нет: ' . implode(', ', $lost) . '. С этими значениями отправка остановится');
			}
			if ($sent)
			{
				$add('ok', $where . '. В БП уходит: ' . implode('; ', $sent));
			}
			$out[$code] = $checks;
		}

		return $out;
	}
}

final class Report
{
	public array $items = [];

	public function ok(string $text): void
	{
		$this->items[] = ['status' => 'ok', 'text' => $text];
	}

	public function info(string $text): void
	{
		$this->items[] = ['status' => 'info', 'text' => $text];
	}

	public function warn(string $text): void
	{
		$this->items[] = ['status' => 'warn', 'text' => $text];
	}

	public function error(string $text): void
	{
		$this->items[] = ['status' => 'error', 'text' => $text];
	}

	public function check(bool $condition, string $ok, string $error): void
	{
		$condition ? $this->ok($ok) : $this->error($error);
	}
}


// ---------- ответы странице ----------

/**
 * JSON для страницы (index.php?action=…). Кто спрашивает — из сессии портала,
 * плюс сверка ключа сессии Битрикса. Доступ проверяется на КАЖДОМ запросе:
 * снятый во вкладке «Доступ» сотрудник теряет его сразу.
 */
final class Api
{
	private const OWNER_ONLY = ['access.list', 'access.users', 'access.add', 'access.remove', 'log.list',
		'check.run', 'settings.get', 'settings.save', 'settings.reset'];

	public static function handle(?array $user): void
	{
		global $APPLICATION;
		try
		{
			if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST')
			{
				throw new AppError('Нужен POST-запрос');
			}
			if ($user === null)
			{
				throw new AppError('Сессия портала закончилась — откройте программу заново');
			}
			$input = json_decode((string)file_get_contents('php://input'), true);
			$input = is_array($input) ? $input : [];
			if (!hash_equals((string)bitrix_sessid(), Text::scalar($input['sessid'] ?? '')))
			{
				throw new AppError('Страница устарела — обновите её');
			}
			$answer = ['ok' => true, 'data' => self::dispatch(Text::scalar($_GET['action'] ?? ''), $input, $user)];
		}
		catch (AppError $e)
		{
			$answer = ['ok' => false, 'error' => $e->getMessage()];
		}
		catch (\Throwable $e)
		{
			// Текст внутренней ошибки нужен тому, кто чинит, а не сотруднику.
			error_log('gross.declarations: ' . $e);
			$details = $user !== null && Access::isOwner($user) ? ': ' . $e->getMessage() : ' — подробности в журнале сервера';
			$answer = ['ok' => false, 'error' => 'Сбой программы' . $details];
		}
		// Лишний вывод портала до нас (пробел или BOM в init.php) сломал бы JSON.
		if (is_object($APPLICATION))
		{
			$APPLICATION->RestartBuffer();
		}
		header('Content-Type: application/json; charset=utf-8');
		header('Cache-Control: no-store');
		header('X-Content-Type-Options: nosniff');
		echo json_encode($answer, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
	}

	private static function dispatch(string $action, array $in, array $user)
	{
		if (!Access::canUse($user))
		{
			throw new AppError('У вас нет доступа к программе — обратитесь к тому, кто её установил');
		}
		if (in_array($action, self::OWNER_ONLY, true) && !Access::isOwner($user))
		{
			throw new AppError('Это может только владелец программы');
		}
		$s = Settings::get();
		$id = (int)Text::scalar($in['id'] ?? 0);
		switch ($action)
		{
			case 'vin.search':
				return Catalog::search($s, Text::scalar($in['q'] ?? ''));
			case 'product.info':
				// Свежая «Модификация» товаров строк: её могли заполнить в каталоге уже после выбора VIN.
				return ['items' => array_values(Catalog::products($s, array_slice(Settings::ids($in['ids'] ?? []), 0, 500)))];

			case 'decl.list':
				return ['items' => Decls::all()];
			case 'decl.save':
				return Decls::save($in['item'] ?? null, $user);
			case 'decl.delete':
				Decls::delete(Text::scalar($in['id'] ?? ''));

				return [];
			case 'decl.send':
				return Decls::send(Text::scalar($in['id'] ?? ''), $user, $s);
			case 'decl.find':
				return Archive::find($s, Text::scalar($in['q'] ?? ''));
			case 'decl.reopen':
				return Decls::reopen($in, $user);

			case 'log.write':
				Journal::write($in['entries'] ?? null, $user);

				return [];
			case 'log.list':
				return ['items' => Journal::latest()];

			case 'access.list':
				return ['owner' => Users::describe([Access::ownerId()])[0] ?? null, 'items' => Users::describe(Access::allowed())];
			case 'access.users':
				return ['items' => array_values(array_filter(Users::search(Text::scalar($in['q'] ?? '')), static function (array $card) {
					return $card['id'] !== Access::ownerId();
				}))];
			case 'access.add':
				$found = $id > 0 ? Users::describe([$id]) : [];
				if (!$found || !$found[0]['active'])
				{
					throw new AppError('Пользователь #' . $id . ' не найден или уволен');
				}
				if ($id === Access::ownerId())
				{
					throw new AppError('У владельца доступ есть всегда');
				}
				Access::grant($id);

				return ['items' => Users::describe(Access::allowed())];
			case 'access.remove':
				Access::revoke($id);

				return ['items' => Users::describe(Access::allowed())];

			case 'check.run':
				return ['sections' => Diagnostics::run($s)];
			case 'settings.get':
				return self::settings($s);
			case 'settings.save':
				return self::settings(Settings::save(is_array($in['settings'] ?? null) ? $in['settings'] : []));
			case 'settings.reset':
				return self::settings(Settings::reset());
		}
		throw new AppError('Неизвестное действие «' . $action . '»');
	}

	/** Настройки и что подобрано само — чтобы было видно, что меняешь. */
	private static function settings(array $s): array
	{
		$auto = ['iblocks' => [], 'error' => ''];
		try
		{
			foreach (Catalog::iblocks(['catalog_iblock_ids' => []] + $s) as $id => $name)
			{
				$auto['iblocks'][] = ['id' => $id, 'name' => $name];
			}
		}
		catch (\Throwable $e)
		{
			$auto['error'] = $e->getMessage();
		}

		return ['settings' => $s, 'auto' => $auto, 'bp' => ['params' => Bp::reference($s)]];
	}
}
