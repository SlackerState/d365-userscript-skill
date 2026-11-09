# 调查和注入手法

下面的片段都在 Claude in Chrome 的 `javascript_tool` 里跑过，在已打开 D365 的标签页执行（同源，自动带登录）。每个片段开头都先定义：

```js
const H = { Accept: 'application/json', 'OData-Version': '4.0', Prefer: 'odata.include-annotations="*"' };
const g = async (p) => (await fetch('/api/data/v9.2/' + p, { credentials: 'include', headers: H })).json();
const F = '@OData.Community.Display.V1.FormattedValue';
```

结果较大时存到 `window.__xxx`，分几次取。结束后清掉。

## 找实体

```js
const ents = await g("EntityDefinitions?$select=LogicalName,EntitySetName,DisplayName");
ents.value.filter(e => /order|invoice/i.test(e.LogicalName + (e.DisplayName?.UserLocalizedLabel?.Label || '')))
  .map(e => e.LogicalName + ' / ' + e.EntitySetName + ' : ' + (e.DisplayName?.UserLocalizedLabel?.Label || ''));
```

找到候选后，查一条真实记录确认，不要只看名字。一定要带 `$select`：不带的元数据响应很大，曾把标签页卡死。

## 字段、选项值、关系

```js
// 字段列表
const a = await g("EntityDefinitions(LogicalName='new_order')/Attributes?$select=LogicalName,AttributeType,DisplayName,IsCustomAttribute");
// 选项值（Picklist）
const o = await g("EntityDefinitions(LogicalName='new_order')/Attributes(LogicalName='new_orderstatus')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet");
o.OptionSet.Options.map(x => x.Value + ' ' + x.Label.UserLocalizedLabel.Label);
// 关系：Lookup 指向谁、写入时用的导航属性名
const r = await g("EntityDefinitions(LogicalName='new_order')/ManyToOneRelationships?$select=ReferencingAttribute,ReferencedEntity,ReferencingEntityNavigationPropertyName");
// 哪些子表指向这个实体
const c = await g("EntityDefinitions(LogicalName='new_parentorder')/OneToManyRelationships?$select=ReferencingEntity,ReferencingAttribute");
```

## 系统视图的过滤条件

```js
const v = await g("savedqueries?$select=name,fetchxml&$filter=returnedtypecode eq 'new_parentorder' and startswith(name,'My Orders')");
v.value.map(x => x.name + '\n' + x.fetchxml.replace(/<attribute name="[^"]+" \/>/g, ''));
```

## 按钮背后的代码

Web Resource 可以直接按名字读。不知道在哪个文件时，遍历所有 JS，按函数名或实体名搜：

```js
const wr = await g("webresourceset?$select=name&$filter=webresourcetype eq 3 and startswith(name,'new_')");
const found = [], list = wr.value.map(x => x.name);
for (let i = 0; i < list.length; i += 8) {
  await Promise.all(list.slice(i, i + 8).map(async n => {
    try {
      const t = await fetch('/WebResources/' + n).then(r => r.text());
      if (/createOrder|new_orders/.test(t)) found.push(n + ' ' + t.length);
    } catch (e) {}
  }));
}
found;
```

读到后截取函数附近的内容，弄清：调什么接口、传什么参数、前端校验了什么、哪些情况下按钮不显示。

## 自定义 API 的参数

```js
const a = await g("customapis?$select=uniquename,bindingtype,isfunction,customapiid&$filter=uniquename eq 'new_withdrawapi'");
const p = await g(`customapirequestparameters?$select=uniquename,type,isoptional&$filter=_customapiid_value eq ${a.value[0].customapiid}`);
```

调查阶段只调用查询型的 API。有写入效果的，只读懂参数，不调用。

## 服务器插件

```js
const f = await g("sdkmessagefilters?$select=sdkmessagefilterid,_sdkmessageid_value&$filter=primaryobjecttypecode eq 'new_order'");
for (const x of f.value) {
  const s = await g(`sdkmessageprocessingsteps?$select=name,stage,mode,filteringattributes,statecode&$filter=_sdkmessagefilterid_value eq ${x.sdkmessagefilterid}`);
  // s.value 里能看到插件名和它监听的字段（filteringattributes）
}
```

账号没权限时会返回 `error`，改用对比数据的方法：比较刚建的记录和已处理过的记录；也可以查 `audits`（`_objectid_value eq <id>`）看字段什么时候被谁改的。

## 嵌入页面和跨域系统

- 网络面板抓不到 iframe 内的请求。先从 iframe 的 `src` 找到 Web Resource，读它的源码。
- iframe 是外部系统时父页面读不到。在同一个标签页用 JS 跳到内嵌地址，就能在那个域里调查它的接口，读它的前端代码找保存接口的请求体。
- 跨两个域的调查，要带数据过去时可以临时放 `window.name`，用完清掉。

## 把脚本注入页面测试

本地 HTTP 服务（`127.0.0.1`）会被 Chrome 的本地网络限制挡住。可靠做法是用文件选择框：

1. 在页面里加一个文件框：

   ```js
   const inp = document.createElement('input');
   inp.type = 'file'; inp.id = '__claude_loader';
   inp.setAttribute('aria-label', 'claude script loader');
   inp.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;';
   inp.onchange = async () => {
     const t = await inp.files[0].text();
     try { (0, eval)(t); window.__loadOk = true; } catch (e) { window.__loadErr = String(e); }
     inp.remove();
   };
   document.body.append(inp); 'ok';
   ```

2. 用 `find` 找到 `claude script loader` 的 ref，再用 `file_upload` 传入脚本的绝对路径。
3. 用 JS 点面板按钮并读结果。

注意：

- 用户的 ScriptCat 可能已经装了同一脚本，页面上会有两个按钮和面板。查找元素时取最后一个（新注入的），或先核对版本。
- 用了 `@grant GM_*` 的脚本注入后拿不到 GM 函数，需要先在 `window` 上放桩函数，或分两半单独测。

## 模拟写入

注入前拦截写接口，**绝不放行到服务器**：

```js
window.__posts = []; window.__mode = 'ok';
const real = window.fetch.bind(window);
window.fetch = async (url, opt) => {
  const method = (opt && opt.method) || 'GET';
  if (method !== 'GET') {
    window.__posts.push({ url: String(url), method, body: opt && opt.body });
    if (window.__mode === 'fail') return new Response(JSON.stringify({ error: { message: '模拟失败' } }), { status: 400, statusText: 'Bad Request', headers: { 'Content-Type': 'application/json' } });
    return new Response(null, { status: 204 });
  }
  return real(url, opt);
};
```

默认拦截所有非 GET 请求，比只拦某个 URL 安全。要测确认框，可临时覆盖 `window.confirm`，测完恢复。写入后的读回校验拿到的仍是真实数据（状态没变），测试时要预期这一点，或一并模拟 GET。
