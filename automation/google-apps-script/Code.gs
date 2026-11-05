/**
 * Gaugeline merge reports: a Google Apps Script web app bound to the status Doc.
 * Deploy it as a web app (execute as you, access: anyone with the link), then set four Script
 * Properties: REPORT_SECRET, SHEET_ID, STATUS_DOC_ID, CHANGELOG_DOC_ID. Save the /exec URL and the
 * secret as the repository secrets REPORT_POST_URL and REPORT_POST_SECRET.
 *
 * The Sheet is the ledger: a report whose id is already in column A changes nothing, so re-running
 * the merge workflow never files twice.
 */
function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ ok: false, error: "body is not JSON" });
  }
  if (!body || body.secret !== props.getProperty("REPORT_SECRET"))
    return reply({ ok: false, error: "wrong secret" });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = SpreadsheetApp.openById(props.getProperty("SHEET_ID")).getSheets()[0];
    var ids = sheet.getLastRow() > 0 ? sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues() : [];
    for (var i = 0; i < ids.length; i++) {
      if (ids[i][0] === body.id) return reply({ ok: true, duplicate: true });
    }
    var r = body.row;
    sheet.appendRow([body.id, r.number, r.title, r.url, r.mergedAt, r.day, r.minutes, r.section]);
    appendUnder(
      DocumentApp.openById(props.getProperty("STATUS_DOC_ID")),
      body.status.week,
      body.status.day,
      body.status.entry,
    );
    if (body.changelog) {
      appendUnder(
        DocumentApp.openById(props.getProperty("CHANGELOG_DOC_ID")),
        body.changelog.section,
        null,
        body.changelog.line,
      );
    }
    return reply({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

/** Append a bullet under heading1 (and heading2 inside it), creating either heading if missing. */
function appendUnder(doc, heading1, heading2, text) {
  var docBody = doc.getBody();
  var at = findHeading(docBody, heading1, DocumentApp.ParagraphHeading.HEADING1, 0);
  if (at < 0) {
    docBody.appendParagraph(heading1).setHeading(DocumentApp.ParagraphHeading.HEADING1);
    at = docBody.getNumChildren() - 1;
  }
  if (heading2) {
    var sub = findHeading(docBody, heading2, DocumentApp.ParagraphHeading.HEADING2, at + 1);
    if (sub < 0) {
      sub = endOfSection(docBody, at, DocumentApp.ParagraphHeading.HEADING1);
      docBody.insertParagraph(sub, heading2).setHeading(DocumentApp.ParagraphHeading.HEADING2);
    }
    at = sub;
  }
  var end = endOfSection(
    docBody,
    at,
    heading2 ? DocumentApp.ParagraphHeading.HEADING2 : DocumentApp.ParagraphHeading.HEADING1,
  );
  docBody.insertListItem(end, text);
}

function findHeading(docBody, text, level, from) {
  for (var i = from; i < docBody.getNumChildren(); i++) {
    var c = docBody.getChild(i);
    if (
      c.getType() === DocumentApp.ElementType.PARAGRAPH &&
      c.asParagraph().getHeading() === level &&
      c.asParagraph().getText() === text
    )
      return i;
  }
  return -1;
}

function endOfSection(docBody, start, level) {
  for (var i = start + 1; i < docBody.getNumChildren(); i++) {
    var c = docBody.getChild(i);
    if (c.getType() === DocumentApp.ElementType.PARAGRAPH) {
      var h = c.asParagraph().getHeading();
      if (
        h === DocumentApp.ParagraphHeading.HEADING1 ||
        (level === DocumentApp.ParagraphHeading.HEADING2 &&
          h === DocumentApp.ParagraphHeading.HEADING2)
      )
        return i;
    }
  }
  return docBody.getNumChildren();
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
