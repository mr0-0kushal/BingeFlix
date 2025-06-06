import { Router } from "express";
import {
    changeCurrentPassword,
    getCurrentUser,
    loginUser,
    logoutUser,
    refreshAccessToken,
    registerUser,
    sendUserOTP,
    updateUserAvatar,
    updateUserDetails,
    loginWithOTP
} from "../controllers/user.controller.js";
import { verifyJWT , verifyOTP } from "../middlewares/auth.middleware.js";
import { upload } from "../middlewares/multer.middleware.js"


const router = Router()

router.route('/register').post(upload.none(), registerUser) //.none() -> only extract text from multipart form
router.route('/login').post(loginUser)
router.route('/logout').post(verifyJWT, logoutUser)
router.route('/refresh-token').post(refreshAccessToken)
router.route('/change-password').post(verifyJWT, changeCurrentPassword)
router.route('/fetch-user').post(verifyJWT, getCurrentUser)
router.route('/update-user').post(verifyJWT, updateUserDetails)
router.route('/update-avatar').post(verifyJWT, upload.single("avatar"), updateUserAvatar)// .single("filename") -> takes single image
router.route('/send-otp').post(sendUserOTP)
router.route('/verify-otp').post(verifyOTP, loginWithOTP)

export default router