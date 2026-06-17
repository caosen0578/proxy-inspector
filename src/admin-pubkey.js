// 管理员令牌验签用的【公钥】（信任根）。
// 公钥公开无妨——使用者看得到也无法伪造令牌，签发令牌必须用配对的【私钥】，
// 私钥只在分发者本人机器（secrets/admin-private-key.pem），绝不进分发包。
//
// 如需轮换：用 scripts/gen-keypair.js 重新生成一对，替换此处公钥即可（旧令牌随即全部失效）。
module.exports = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAypH7np50WcAoRO9EW4ivxJK7FWKzn5YzXm0RgUeovqY=
-----END PUBLIC KEY-----
`;
