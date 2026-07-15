/**
 * Код для Google Apps Script.
 * Как подключить:
 * 1. Откройте (или создайте) Google Таблицу, в которую нужно писать данные.
 * 2. Меню "Расширения" → "Apps Script".
 * 3. Удалите содержимое редактора и вставьте весь этот код.
 * 4. Нажмите "Развернуть" → "Новое развёртывание".
 * 5. Тип: "Веб-приложение".
 *    - Выполнять от имени: "Меня"
 *    - У кого есть доступ: "Все"
 * 6. Нажмите "Развернуть", разрешите доступ (может появиться предупреждение
 *    Google о непроверенном приложении — это нормально, это ваш скрипт).
 * 7. Скопируйте выданный URL (заканчивается на /exec) и вставьте его
 *    в поле "Подключение к Google Таблице" в HTML-странице.
 *
 * Скрипт сам создаст лист "Data" при первой отправке данных
 * и лист "Тотал" с формулами SUM по всем колонкам.
 *
 * ВАЖНО: значения за дату полностью ПЕРЕЗАПИСЫВАЮТСЯ при каждой отправке
 * (а не складываются с предыдущими) — дашборд каждый раз присылает
 * актуальное состояние дня целиком.
 *
 * НОВОЕ: теперь дашборд может не только добавлять/править записи,
 * но и полностью УДАЛЯТЬ строку за конкретную дату из листа "Data"
 * (action = "delete"), а также удалять целиком колонку статуса
 * (action = "deleteStatus"). Оба действия сразу пересчитывают лист "Тотал".
 *
 * ВАЖНО ПРО ЗАПРОСЫ: чтобы избежать CORS preflight-запросов (которые
 * Apps Script веб-приложения не поддерживают), дашборд всегда шлёт POST
 * с Content-Type: text/plain — и action/save/delete передаются внутри
 * JSON-тела, а не через настоящий HTTP DELETE.
 */

var METRIC_HEADERS = ['Дата','Открыто','Кликнуло','Трекер→CRM','Зашло в CRM','Отправлено','Дубли','Не отправлено'];
var METRIC_KEYS = ['opened','clicked','trackerToCRM','enteredCRM','sent','duplicates','notSent'];

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    var action = payload.action || 'save';

    if (action === 'delete') {
      return deleteEntryRow(payload.date);
    }
    if (action === 'deleteStatus') {
      return deleteStatusColumn(payload.name);
    }
    if (action === 'addStatus') {
      return addStatusColumn(payload.name);
    }
    return saveEntryRow(payload);

  } catch (err) {
    Logger.log('Error in doPost: ' + err.toString());
    return jsonOutput({ ok: false, error: err.toString() });
  }
}

function saveEntryRow(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Data');
  if (!sheet) {
    sheet = ss.insertSheet('Data');
    sheet.appendRow(METRIC_HEADERS);
  }

  var lastCol = Math.max(sheet.getLastColumn(), METRIC_HEADERS.length);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  // добавляем колонки под новые статусы, если их ещё нет
  var statusNames = Object.keys(payload.statuses || {});
  statusNames.forEach(function (name) {
    if (headers.indexOf(name) === -1) {
      var col = headers.length + 1;
      sheet.getRange(1, col).setValue(name);
      headers.push(name);
    }
  });

  var dateStr = normalizeDateString(payload.date);
  var rowIndex = findRowByDate(sheet, dateStr);

  if (rowIndex === -1) {
    var newRow = new Array(headers.length).fill(0);
    newRow[0] = dateStr;
    sheet.appendRow(newRow);
    rowIndex = sheet.getLastRow();
  }

  // Полная перезапись значений за эту дату (не накопление).
  METRIC_KEYS.forEach(function (key, idx) {
    var col = idx + 2;
    var val = Number((payload.metrics || {})[key]) || 0;
    sheet.getRange(rowIndex, col).setValue(val);
  });

  statusNames.forEach(function (name) {
    var col = headers.indexOf(name) + 1;
    var val = Number(payload.statuses[name]) || 0;
    sheet.getRange(rowIndex, col).setValue(val);
  });

  updateTotalsSheet(ss, sheet);

  return jsonOutput({ ok: true });
}

function deleteEntryRow(dateStr) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Data');
  if (!sheet) return jsonOutput({ ok: true }); // нечего удалять

  dateStr = normalizeDateString(dateStr);
  var rowIndex = findRowByDate(sheet, dateStr);
  
  if (rowIndex === -1) {
    Logger.log('Row not found for date: ' + dateStr);
    return jsonOutput({ ok: false, error: 'Запись за эту дату не найдена: ' + dateStr });
  }

  Logger.log('Deleting row: ' + rowIndex + ' for date: ' + dateStr);
  sheet.deleteRow(rowIndex);
  updateTotalsSheet(ss, sheet);

  return jsonOutput({ ok: true });
}

function addStatusColumn(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Data');
  if (!sheet) {
    sheet = ss.insertSheet('Data');
    sheet.appendRow(METRIC_HEADERS);
  }
  var lastCol = Math.max(sheet.getLastColumn(), METRIC_HEADERS.length);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  if (headers.indexOf(name) === -1) {
    sheet.getRange(1, headers.length + 1).setValue(name);
  }
  updateTotalsSheet(ss, sheet);
  return jsonOutput({ ok: true });
}

function deleteStatusColumn(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Data');
  if (!sheet) return jsonOutput({ ok: true });

  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var col = headers.indexOf(name) + 1;

  if (col <= METRIC_HEADERS.length) {
    // защита: нельзя удалить встроенные колонки метрик
    return jsonOutput({ ok: false, error: 'Эту колонку удалить нельзя' });
  }
  if (col === 0) {
    return jsonOutput({ ok: true }); // такого статуса и не было
  }

  sheet.deleteColumn(col);
  updateTotalsSheet(ss, sheet);

  return jsonOutput({ ok: true });
}

function normalizeDateString(dateInput) {
  // Преобразует дату в формат YYYY-MM-DD
  if (!dateInput) return '';
  
  // Если уже в формате YYYY-MM-DD
  if (typeof dateInput === 'string' && dateInput.match(/^\d{4}-\d{2}-\d{2}$/)) {
    return dateInput;
  }
  
  // Если это Date объект
  if (dateInput instanceof Date) {
    return Utilities.formatDate(dateInput, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  
  // Если строка в другом формате, пробуем распарсить
  if (typeof dateInput === 'string') {
    try {
      var d = new Date(dateInput);
      if (!isNaN(d.getTime())) {
        return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      }
    } catch (e) {
      // ignore
    }
  }
  
  return String(dateInput);
}

function findRowByDate(sheet, dateStr) {
  var data = sheet.getDataRange().getValues();
  var normalizedSearchDate = normalizeDateString(dateStr);
  
  Logger.log('Looking for date: ' + normalizedSearchDate);
  
  for (var i = 1; i < data.length; i++) {
    var cellVal = data[i][0];
    var cellDate = normalizeDateString(cellVal);
    
    Logger.log('Row ' + (i + 1) + ' has date: ' + cellDate);
    
    if (cellDate === normalizedSearchDate) {
      return i + 1;
    }
  }
  return -1;
}

function doGet(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Data');
  if (!sheet) {
    return jsonOutput({ headers: METRIC_HEADERS, rows: [] });
  }
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var rows = data.slice(1).map(function (row) {
    return row.map(function (cell) {
      if (cell instanceof Date) {
        return Utilities.formatDate(cell, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      }
      return cell;
    });
  });
  return jsonOutput({ headers: headers, rows: rows });
}

function updateTotalsSheet(ss, dataSheet) {
  var totals = ss.getSheetByName('Тотал');
  if (!totals) totals = ss.insertSheet('Тотал');
  totals.clear();
  
  var lastCol = dataSheet.getLastColumn();
  var lastRow = dataSheet.getLastRow();
  
  if (lastRow < 2) {
    // Только заголовок, нет данных
    var headers = dataSheet.getRange(1, 1, 1, lastCol).getValues()[0];
    totals.getRange(1, 1, 1, lastCol).setValues([headers]);
    totals.getRange(2, 1).setValue('ИТОГО');
    return;
  }
  
  var headers = dataSheet.getRange(1, 1, 1, lastCol).getValues()[0];
  totals.getRange(1, 1, 1, lastCol).setValues([headers]);
  totals.getRange(2, 1).setValue('ИТОГО');
  
  for (var c = 2; c <= lastCol; c++) {
    var colLetter = columnToLetter(c);
    totals.getRange(2, c).setFormula('=SUM(Data!' + colLetter + '2:' + colLetter + lastRow + ')');
  }
}

function columnToLetter(column) {
  var temp, letter = '';
  while (column > 0) {
    temp = (column - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    column = (column - temp - 1) / 26;
  }
  return letter;
}

function jsonOutput(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
