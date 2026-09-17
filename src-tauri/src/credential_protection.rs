//! OS-bound credential encryption shared by private publishing and Bilibili login.
#[cfg(windows)]
pub(crate) fn protect(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len().try_into().map_err(|_| "凭据过大。")?,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: input is live and read-only for the call; Windows allocates output, freed below.
    let ok = unsafe {
        if decrypt {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err("Windows 无法解锁或保护凭据，请用保存连接时的 Windows 账户重试。".into());
    }
    // SAFETY: success guarantees a valid DPAPI allocation of cbData bytes.
    let result =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(result)
}
#[cfg(not(windows))]
pub(crate) fn protect(_: &[u8], _: bool) -> Result<Vec<u8>, String> {
    Err("当前版本的私人库凭据保险箱仅支持 Windows。".into())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn roundtrip_is_not_plaintext_and_tampering_fails() {
        let secret = b"a-private-token-never-saved-as-plaintext";
        let mut encrypted = protect(secret, false).unwrap();
        assert!(!encrypted.windows(secret.len()).any(|v| v == secret));
        assert_eq!(protect(&encrypted, true).unwrap(), secret);
        let i = encrypted.len() / 2;
        encrypted[i] ^= 1;
        assert!(protect(&encrypted, true).is_err());
    }
}
