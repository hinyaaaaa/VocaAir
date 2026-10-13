/* VocaAir 設定
   pushApi には、worker/ をデプロイして得られる URL（例: https://vocaair-push.xxxx.workers.dev）を入れる。
   空のままでも動くが、その場合の通知は「アプリを開いている間」だけになる。
   vapidPublicKey は公開してよい鍵（秘密鍵は Worker 側のシークレットにのみ置く）。 */
window.VA_CONFIG = {
  vapidPublicKey: 'BLpaUhqBy-3zFj0w9oQBWi2bhVlXyU445Fb_UH94WVP3QCPU_4PdjzSuq9ut124_NafSVMC3WfwhhT-mGGaqxUY',
  pushApi: ''
};
