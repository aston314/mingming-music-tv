const assert = require('assert/strict');

module.exports = async function testPhoneLogin({browser, url}) {
  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  let session;
  try {
    session = await (await context.request.post(url + '/api/scan', {data: {scope: 'login'}})).json();
    assert.ok(session.id && session.url, 'fixture must create a scoped phone session');
    const phoneURL = new URL(session.url); phoneURL.hostname = '127.0.0.1';
    const page = await context.newPage();
    await page.route('**/submit', route => {
      assert.deepEqual(route.request().postDataJSON(), {scope: 'login', username: 'fixture-user', password: 'fixture-password'});
      return route.fulfill({status: 409, json: {deviceLimit: true, devices: [{tokenTail: 'old-device', deviceName: '原设备'}, {deviceName: '无效设备'}]}});
    });
    let count = 0, release, started;
    const resolving = new Promise(resolve => {started = resolve;});
    await page.route('**/resolve', async route => {
      count++;
      assert.deepEqual(route.request().postDataJSON(), {scope: 'login', kickTail: count === 1 ? 'old-device' : 'new-device'});
      if (count === 1) {
        const gate = new Promise(resolve => {release = resolve;}); started(); await gate;
        await route.fulfill({json: {deviceLimit: true, devices: [{tokenTail: 'new-device', deviceName: '更新设备'}]}});
      } else if (count === 2) {
        await route.fulfill({status: 502, json: {error: '下线登录暂时失败，请重试或选择其它设备', retryable: true}});
      } else {
        await route.fulfill({json: {success: true, message: '已完成，电视正在同步账号'}});
      }
    });
    await page.goto(phoneURL.href);
    await page.locator('#value').fill('fixture-user');
    await page.locator('#password').fill('fixture-password');
    await page.locator('#submit').click();
    await page.waitForSelector('#devices .device');
    assert.equal(await page.locator('#devices button').nth(1).isDisabled(), true);
    await page.locator('#devices button').first().click(); await resolving;
    assert.equal(await page.locator('#devices button').first().isDisabled(), true, 'block duplicate device kicks');
    release();
    await page.waitForFunction(() => document.querySelector('#devices button').textContent.indexOf('更新设备') >= 0);
    await page.locator('#devices button').click();
    await page.waitForFunction(() => document.getElementById('message').textContent.indexOf('暂时失败') >= 0);
    assert.equal(await page.locator('#devices').isVisible(), true);
    assert.equal(await page.locator('#devices button').isEnabled(), true, 'temporary failure permits retry');
    await page.locator('#devices button').click();
    await page.waitForFunction(() => document.getElementById('message').textContent.indexOf('已完成') >= 0);
    assert.equal(await page.locator('#devices').isVisible(), false);
    assert.equal(await page.locator('#password').inputValue(), '');
    assert.equal(await page.locator('#value').inputValue(), '');
    assert.equal(count, 3);
    console.log('Phone login device refresh, retry and credential cleanup passed');
  } finally {
    if (session && session.id) await context.request.delete(url + '/api/scan/' + session.id);
    await context.close();
  }
};
